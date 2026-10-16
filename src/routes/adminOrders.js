const router = require('express').Router();
const { z } = require('zod');
const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const HttpError = require('../utils/httpError');
const { moveShipment } = require('../services/shipments');
const wallet = require('../services/wallet');

router.use(protect, requireRole('admin'));

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
  // So the list can offer the next step (confirm, pack, ship, deliver) without opening the order.
  payment: order.paymentStatus === 'cod' ? 'Pay on delivery' : order.paymentMethod === 'cod' ? 'Paid on delivery' : undefined,
  shipments: shipments.map((s) => ({ id: s._id, status: s.status })),
});

// filter: open (still being worked on), attention, done, all
router.get('/orders', async (req, res) => {
  const filter = String(req.query.filter ?? 'open');
  const orders = await Order.find({ paymentStatus: { $in: ['paid', 'mismatch', 'pending', 'cod'] } })
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

const ALL = ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];
const statusSchema = z.object({ status: z.enum(ALL) });

// Moves one shipment forward a step, or cancels it. The admin may set any status.
router.patch('/shipments/:id/status', validate(statusSchema), async (req, res) => {
  const shipment = await Shipment.findById(req.params.id);
  if (!shipment) throw new HttpError(404, 'Shipment not found');
  await moveShipment(shipment, req.body.status, ALL);
  res.json({ shipment });
});

// After a return or refund on a vendor's delivered shipment, take the vendor's credit back.
router.post('/shipments/:id/reverse-credit', async (req, res) => {
  const shipment = await Shipment.findById(req.params.id);
  if (!shipment) throw new HttpError(404, 'Shipment not found');
  if (shipment.status !== 'delivered') throw new HttpError(409, 'Only a delivered shipment has a credit to take back');
  const net = await wallet.reverseCredit(shipment);
  shipment.refundedAt = new Date();
  await shipment.save();
  res.json({ takenBack: net });
});

module.exports = router;
