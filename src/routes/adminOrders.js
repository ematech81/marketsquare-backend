const router = require('express').Router();
const { z } = require('zod');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Shipment = require('../models/Shipment');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const HttpError = require('../utils/httpError');
const User = require('../models/User');
const emails = require('../services/emails');

router.use(protect, requireRole('admin'));

const FLOW = ['placed', 'confirmed', 'packed', 'shipped', 'delivered'];

// One label for the whole order, worked out from its shipments.
function orderStatus(order, shipments) {
  if (order.paymentStatus === 'pending') return 'Awaiting payment';
  if (order.paymentStatus === 'failed') return 'Payment failed';
  if (order.paymentStatus === 'mismatch') return 'Needs attention';
  const s = shipments.map((x) => x.status);
  if (s.length > 0 && s.every((x) => x === 'cancelled')) return 'Cancelled';
  const live = s.filter((x) => x !== 'cancelled');
  if (live.length > 0 && live.every((x) => x === 'delivered')) return 'Delivered';
  if (live.some((x) => x === 'shipped' || x === 'delivered')) {
    return live.every((x) => x === 'shipped' || x === 'delivered') ? 'Shipped' : 'Partly shipped';
  }
  if (live.some((x) => x === 'packed')) return 'Packed';
  if (live.some((x) => x === 'confirmed')) return 'Confirmed';
  return 'New';
}

const summary = (order, shipments) => ({
  orderNumber: order.orderNumber,
  customer: order.user?.name ?? '-',
  total: order.total,
  status: orderStatus(order, shipments),
  needsAttention: order.needsAttention,
  createdAt: order.createdAt,
  itemCount: order.items.reduce((n, i) => n + i.quantity, 0),
});

// filter: open (still being worked on), attention, done, all
router.get('/orders', async (req, res) => {
  const filter = String(req.query.filter ?? 'open');
  const orders = await Order.find({ paymentStatus: { $in: ['paid', 'mismatch', 'pending'] } })
    .populate('user', 'name')
    .sort({ createdAt: -1 })
    .limit(300);
  const shipments = await Shipment.find({ order: { $in: orders.map((o) => o._id) } }).select('order status');

  const rows = orders.map((o) => {
    const own = shipments.filter((s) => String(s.order) === String(o._id));
    return summary(o, own);
  });

  const isOpen = (r) => ['New', 'Confirmed', 'Packed', 'Shipped', 'Partly shipped'].includes(r.status);
  const counts = {
    open: rows.filter(isOpen).length,
    toConfirm: rows.filter((r) => r.status === 'New').length,
    attention: rows.filter((r) => r.status === 'Needs attention' || r.needsAttention).length,
  };

  const shown = rows.filter((r) => {
    if (filter === 'open') return isOpen(r);
    if (filter === 'attention') return r.status === 'Needs attention' || r.needsAttention;
    if (filter === 'done') return r.status === 'Delivered' || r.status === 'Cancelled';
    return true;
  });
  res.json({ orders: shown, counts });
});

router.get('/orders/:orderNumber', async (req, res) => {
  const order = await Order.findOne({ orderNumber: req.params.orderNumber }).populate('user', 'name email phone');
  if (!order) throw new HttpError(404, 'Order not found');
  const shipments = await Shipment.find({ order: order._id }).populate('vendor', 'businessName');
  const o = order.toObject();
  delete o.checkoutReference;
  res.json({
    order: {
      ...o,
      status: orderStatus(order, shipments),
      shipments: shipments.map((s) => ({ ...s.toObject(), vendorName: s.vendor ? s.vendor.businessName : 'Square Market', vendor: undefined })),
    },
  });
});

const statusSchema = z.object({ status: z.enum(['confirmed', 'packed', 'shipped', 'delivered', 'cancelled']) });

// Moves one shipment forward a step, or cancels it.
router.patch('/shipments/:id/status', validate(statusSchema), async (req, res) => {
  const shipment = await Shipment.findById(req.params.id);
  if (!shipment) throw new HttpError(404, 'Shipment not found');
  const { status } = req.body;

  if (shipment.status === 'delivered' || shipment.status === 'cancelled') {
    throw new HttpError(409, `This shipment is already ${shipment.status}`);
  }

  if (status === 'cancelled') {
    // Put the stock back, once, for the lines whose stock was taken at payment.
    for (const item of shipment.items) {
      if (item.stockTaken) {
        await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } });
        item.stockTaken = false;
      }
    }
  } else if (FLOW.indexOf(status) !== FLOW.indexOf(shipment.status) + 1) {
    throw new HttpError(409, `A ${shipment.status} shipment cannot go straight to ${status}. Do each step in order`);
  }

  shipment.status = status;
  shipment.timeline.push({ status, at: new Date() });
  await shipment.save();

  if (['shipped', 'delivered', 'cancelled'].includes(status)) {
    const order = await Order.findById(shipment.order);
    const user = order && (await User.findById(order.user));
    if (order && user) emails.shipmentUpdate(order, user, shipment);
  }
  res.json({ shipment });
});

module.exports = router;
