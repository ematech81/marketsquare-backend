const router = require('express').Router();
const crypto = require('crypto');
const { z } = require('zod');
const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const DeliveryZone = require('../models/DeliveryZone');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { readCart } = require('../services/cart');
const korapay = require('../services/korapay');
const { markOrderPaid, placeCodOrder } = require('../services/orders');
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
    shipments: shipments.map((s) => ({ ...s.toObject(), vendorName: s.vendor ? s.vendor.businessName : 'Square Market', vendor: undefined })),
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
  const zone = await DeliveryZone.findOne({ state: address.state });
  if (!zone) throw new HttpError(400, `We do not deliver to ${address.state} yet`);

  // One delivery fee per seller.
  const sellers = [...new Set(cart.items.map((i) => (i.vendor ? String(i.vendor) : null)))];
  const deliveries = sellers.map((v) => ({ vendor: v, fee: zone.fee, estimatedDays: zone.estimatedDays }));
  const deliveryTotal = deliveries.reduce((sum, d) => sum + d.fee, 0);
  const total = cart.subtotal + deliveryTotal;

  if (cod) {
    const { codEnabled, codMaxAmount } = await getStoreSettings();
    if (!codEnabled) throw new HttpError(400, 'Pay on delivery is not available right now. Please pay online');
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

router.get('/', async (req, res) => {
  const orders = await Order.find({ user: req.user._id, paymentStatus: { $ne: 'failed' } }).sort({ createdAt: -1 });
  res.json({ orders: orders.map((o) => ({ ...o.toObject(), checkoutReference: undefined })) });
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
