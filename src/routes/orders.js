const router = require('express').Router();
const crypto = require('crypto');
const { z } = require('zod');
const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const { quoteCart } = require('../services/delivery');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { readCart } = require('../services/cart');
const korapay = require('../services/korapay');
const { markOrderPaid, placeCodOrder } = require('../services/orders');
const { moveShipment } = require('../services/shipments');
const { openDispute } = require('../services/disputes');
const { getStoreSettings } = require('../services/storeSettings');
const { webUrl, minOrderAmount } = require('../config/env');
const states = require('../utils/nigeriaStates');
const HttpError = require('../utils/httpError');
const { checkoutLimiter } = require('../middleware/rateLimit');

router.use(protect);

const checkoutSchema = z.object({
  address: z.object({
    fullName: z.string().trim().min(2, 'Enter the receiver\'s name'),
    phone: z.string().trim().regex(/^(\+234|0)\d{10}$/, 'Enter a valid Nigerian phone number'),
    street: z.string().trim().min(5, 'Enter the street address'),
    city: z.string().trim().min(2, 'Enter your city'),
    state: z.enum(states, { message: 'Choose your state' }),
    landmark: z.string().trim().optional(),
  }),
  email: z.string().trim().toLowerCase().email('Enter a valid email').optional(),
  paymentMethod: z.enum(['online', 'cod'], { message: 'Choose how you want to pay' }).default('online'),
});

// A customer can have this many pay-on-delivery orders waiting to be delivered. It stops someone from reserving
// stock with orders they never intend to take.
const MAX_OPEN_COD_ORDERS = 3;

const orderNumber = () => `SM-${crypto.randomInt(10000000, 99999999)}`;

const view = async (order) => {
  const shipments = await Shipment.find({ order: order._id }).populate('vendor', 'businessName');
  const o = order.toObject();
  delete o.checkoutReference;
  return {
    ...o,
    shipments: shipments.map((s) => {
      const o = s.toObject();
      // What the vendor earns and the wrong-code counter are not the customer's business. The delivery code is shown
      // only while the order is on its way, because that is when the customer needs it.
      const open = o.dispute?.status === 'open';
      const flags = {
        // "I received my order" works once it has shipped. "Report a problem" works until the vendor's money is released.
        canConfirm: o.status === 'shipped' && !open,
        canReport: ['shipped', 'delivered'].includes(o.status) && !open && !o.earning?.releasedAt,
      };
      delete o.earning;
      delete o.codeAttempts;
      if (o.dispute) o.dispute = { status: o.dispute.status, reason: o.dispute.reason, openedAt: o.dispute.openedAt };
      if (o.status !== 'shipped') delete o.deliveryCode;
      return { ...o, ...flags, vendorName: s.vendor ? s.vendor.businessName : 'Square Market', vendor: undefined };
    }),
  };
};

router.post('/checkout', checkoutLimiter, validate(checkoutSchema), async (req, res) => {
  const cod = req.body.paymentMethod === 'cod';
  const prefix = process.env.KORAPAY_PREFIX;
  if (!cod && (!prefix || !/^[A-Z]{3,4}$/.test(prefix))) throw new HttpError(503, 'Payments are not set up yet');
  const currency = process.env.KORAPAY_CURRENCY || 'NGN';

  const cart = await readCart(req.user._id);
  if (cart.items.length === 0) throw new HttpError(400, 'Your cart is empty');
  const problem = cart.items.find((i) => i.issue);
  if (problem) throw new HttpError(409, `${problem.product.title}: ${problem.issue}. Update your cart to continue`);

  if (cart.subtotal < minOrderAmount) {
    const short = minOrderAmount - cart.subtotal;
    throw new HttpError(400, `The minimum order is ₦${minOrderAmount.toLocaleString('en-NG')}. Add ₦${short.toLocaleString('en-NG')} more to check out`);
  }

  const { address } = req.body;
  // One delivery fee per seller: the store's own fee for the state, or the vendor's own fee when they deliver themselves.
  const sellers = [...new Set(cart.items.map((i) => (i.vendor ? String(i.vendor) : null)))];
  const quotes = await quoteCart(sellers, address.state);
  const cannot = quotes.find((q) => !q.quote);
  if (cannot) {
    throw new HttpError(
      400,
      cannot.vendor ? `${cannot.name} does not deliver to ${address.state}. Remove their items or choose another state` : `We do not deliver to ${address.state} yet`
    );
  }
  const deliveries = quotes.map((q) => ({ vendor: q.vendor, fee: q.quote.fee, estimatedDays: q.quote.estimatedDays, mode: q.quote.mode }));
  const deliveryTotal = deliveries.reduce((sum, d) => sum + d.fee, 0);
  const total = cart.subtotal + deliveryTotal;

  if (cod) {
    const { codEnabled, codMaxAmount } = await getStoreSettings();
    if (!codEnabled) throw new HttpError(400, 'Pay on delivery is not available right now. Please pay online');
    // Cash is only collected by Square Market. A vendor who delivers their own orders is never handed cash that
    // belongs to the platform, so those orders are paid online (the same rule Konga uses for seller-delivered orders).
    if (deliveries.some((d) => d.mode === 'vendor')) {
      throw new HttpError(400, 'Pay on delivery is not available for items a vendor delivers themselves. Please pay online');
    }
    if (total > codMaxAmount) {
      throw new HttpError(400, `Pay on delivery is available for orders up to ₦${codMaxAmount.toLocaleString('en-NG')}. Please pay online for this order`);
    }
    if ((await Order.countDocuments({ user: req.user._id, paymentStatus: 'cod' })) >= MAX_OPEN_COD_ORDERS) {
      throw new HttpError(409, 'You have pay-on-delivery orders still waiting to be delivered. Please wait for them, or pay online for this one');
    }
  }

  const order = await Order.create({
    user: req.user._id,
    orderNumber: orderNumber(),
    items: cart.items.map((i) => ({
      product: i.product.id,
      vendor: i.vendor,
      title: i.product.title,
      image: i.product.image,
      price: i.price,
      quantity: i.quantity,
      options: i.options,
    })),
    address,
    contactEmail: req.body.email,
    subtotal: cart.subtotal,
    deliveries,
    deliveryTotal,
    total,
    currency,
    paymentMethod: cod ? 'cod' : 'online',
    paymentStatus: cod ? 'cod' : 'pending',
    // {PREFIX}-{uuid}: the router sends the webhook back here because of the prefix. A pay-on-delivery order
    // has no payment to wait for, so its reference never matches a KoraPay event.
    checkoutReference: cod ? `COD-${crypto.randomUUID()}` : `${prefix}-${crypto.randomUUID()}`,
  });

  if (cod) {
    await placeCodOrder(order);
    return res.status(201).json({ orderNumber: order.orderNumber, paymentMethod: 'cod' });
  }

  let charge;
  try {
    charge = await korapay.initializeCharge({
      amount: total,
      currency,
      reference: order.checkoutReference,
      customer: { name: address.fullName, email: req.body.email ?? req.user.email },
      redirectUrl: `${webUrl}/orders/${order.orderNumber}`,
    });
  } catch (err) {
    await Order.updateOne({ _id: order._id }, { paymentStatus: 'failed' });
    throw err;
  }

  res.status(201).json({ orderNumber: order.orderNumber, checkoutUrl: charge.checkout_url });
});

// Where an order has got to, in a word, worked out from its shipments.
function progressOf(statuses) {
  const live = statuses.filter((s) => s !== 'cancelled');
  if (statuses.length === 0) return undefined;
  if (live.length === 0) return 'Cancelled';
  if (live.every((s) => s === 'delivered')) return 'Delivered';
  if (live.every((s) => s === 'shipped' || s === 'delivered')) return 'Shipped';
  if (live.some((s) => s === 'shipped' || s === 'delivered')) return 'Partly shipped';
  if (live.some((s) => s === 'packed')) return 'Packed';
  if (live.some((s) => s === 'confirmed')) return 'Confirmed';
  return 'Order placed';
}

// What delivery would cost for the signed-in customer's cart, seller by seller, for a state.
// The checkout page shows it before they pay, so nobody is surprised.
router.get('/delivery-quote', async (req, res) => {
  const state = String(req.query.state ?? '');
  if (!states.includes(state)) throw new HttpError(400, 'state: Choose your state');
  const cart = await readCart(req.user._id);
  const sellers = [...new Set(cart.items.map((i) => (i.vendor ? String(i.vendor) : null)))];
  const quotes = await quoteCart(sellers, state);
  res.json({
    sellers: quotes.map((q) => ({
      vendor: q.vendor,
      name: q.name,
      available: Boolean(q.quote),
      mode: q.quote?.mode,
      fee: q.quote?.fee,
      estimatedDays: q.quote?.estimatedDays,
    })),
    // Pay on delivery needs every seller to be delivered by Square Market.
    codAllowed: quotes.every((q) => q.quote && q.quote.mode === 'platform'),
  });
});

router.get('/', async (req, res) => {
  const orders = await Order.find({ user: req.user._id, paymentStatus: { $ne: 'failed' } }).sort({ createdAt: -1 });
  const shipments = await Shipment.find({ order: { $in: orders.map((o) => o._id) } }).select('order status');
  res.json({
    orders: orders.map((o) => ({
      ...o.toObject(),
      checkoutReference: undefined,
      progress: progressOf(shipments.filter((s) => String(s.order) === String(o._id)).map((s) => s.status)),
    })),
  });
});

const findMine = async (req) => {
  const order = await Order.findOne({ orderNumber: req.params.orderNumber });
  if (!order || (String(order.user) !== String(req.user._id) && req.user.role !== 'admin')) {
    throw new HttpError(404, 'Order not found');
  }
  return order;
};

router.get('/:orderNumber', async (req, res) => {
  res.json({ order: await view(await findMine(req)) });
});

// "I received my order": the customer confirms it arrived. This is how an order is completed when the person who
// delivered it has no code, and it proves delivery just as well.
router.post('/:orderNumber/shipments/:id/confirm-delivery', async (req, res) => {
  const order = await findMine(req);
  const shipment = await Shipment.findOne({ _id: req.params.id, order: order._id });
  if (!shipment) throw new HttpError(404, 'Shipment not found');
  if (String(order.user) !== String(req.user._id)) throw new HttpError(403, 'Only the customer can confirm delivery');
  if (shipment.status !== 'shipped') throw new HttpError(409, 'You can confirm it once the order is on its way');
  if (shipment.dispute?.status === 'open') throw new HttpError(409, 'You reported a problem with this order. Square Market is looking into it');
  await moveShipment(shipment, 'delivered', ['delivered'], { by: 'customer' });
  res.json({ order: await view(await Order.findById(order._id)) });
});

// "Report a problem": the vendor's money for this shipment is held until Square Market decides.
router.post('/:orderNumber/shipments/:id/report', validate(z.object({ reason: z.string().trim() })), async (req, res) => {
  const order = await findMine(req);
  const shipment = await Shipment.findOne({ _id: req.params.id, order: order._id });
  if (!shipment) throw new HttpError(404, 'Shipment not found');
  if (String(order.user) !== String(req.user._id)) throw new HttpError(403, 'Only the customer can report a problem');
  await openDispute(shipment, req.body.reason);
  res.json({ order: await view(await Order.findById(order._id)) });
});

// The customer's return page calls this so the order updates even if the webhook is a few seconds late.
router.post('/:orderNumber/verify', async (req, res) => {
  const order = await findMine(req);
  if (order.paymentStatus === 'pending') {
    const charge = await korapay.verifyCharge(order.checkoutReference);
    if (charge.status === 'success') await markOrderPaid(order, charge.amount);
    else if (['failed', 'cancelled', 'canceled', 'expired'].includes(charge.status)) await Order.updateOne({ _id: order._id, paymentStatus: 'pending' }, { paymentStatus: 'failed' });
  }
  res.json({ order: await view(await Order.findById(order._id)) });
});

module.exports = router;
