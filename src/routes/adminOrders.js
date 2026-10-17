const router = require('express').Router();
const { z } = require('zod');
const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const HttpError = require('../utils/httpError');
const { moveShipment } = require('../services/shipments');
const wallet = require('../services/wallet');
const { resolveDispute } = require('../services/disputes');
const { cancelOrder } = require('../services/cancellation');
const { notifyUser } = require('../services/notifications');

router.use(protect, requireRole('admin'));

// One label for the whole order, worked out from its shipments.
function orderStatus(order, shipments) {
  if (order.paymentStatus === 'cancelled') return 'Cancelled';
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
  shipments: shipments.map((s) => ({ id: s._id, status: s.status, dispute: s.dispute?.status })),
  dispute: shipments.some((s) => s.dispute?.status === 'open'),
  // Cancelled after the customer paid online: the money still has to go back.
  refundDue: order.refund?.status === 'due',
});

// filter: open (still being worked on), attention, done, all
router.get('/orders', async (req, res) => {
  const filter = String(req.query.filter ?? 'open');
  const orders = await Order.find({ paymentStatus: { $in: ['paid', 'mismatch', 'pending', 'cod', 'cancelled'] } })
    .populate('user', 'name')
    .sort({ createdAt: -1 })
    .limit(300);
  const shipments = await Shipment.find({ order: { $in: orders.map((o) => o._id) } }).select('order status dispute');

  const rows = orders.map((o) => {
    const own = shipments.filter((s) => String(s.order) === String(o._id));
    return summary(o, own);
  });

  const isOpen = (r) => ['New', 'Confirmed', 'Packed', 'Shipped', 'Partly shipped'].includes(r.status);
  const counts = {
    open: rows.filter(isOpen).length,
    toConfirm: rows.filter((r) => r.status === 'New').length,
    attention: rows.filter((r) => r.status === 'Needs attention' || r.needsAttention || r.dispute || r.refundDue).length,
  };

  const shown = rows.filter((r) => {
    if (filter === 'open') return isOpen(r);
    if (filter === 'attention') return r.status === 'Needs attention' || r.needsAttention || r.dispute || r.refundDue;
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

// Cancels the whole order (every package that has not been delivered). A paid online order then shows "Refund due".
router.post('/orders/:orderNumber/cancel', validate(z.object({ reason: z.string().trim().min(2, 'Give a reason').max(100), note: z.string().trim().max(300).optional() })), async (req, res) => {
  const order = await Order.findOne({ orderNumber: req.params.orderNumber });
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.paymentStatus === 'cancelled' || order.cancelledAt) throw new HttpError(409, 'This order is already cancelled');
  if (['failed', 'mismatch'].includes(order.paymentStatus)) throw new HttpError(409, 'This order was not paid, so there is nothing to cancel');
  await cancelOrder(order, { by: 'admin', reason: req.body.reason, note: req.body.note });
  res.json({ ok: true });
});

// The refund has been sent from the KoraPay dashboard.
router.post('/orders/:orderNumber/refund', validate(z.object({ note: z.string().trim().max(300).optional() })), async (req, res) => {
  const order = await Order.findOne({ orderNumber: req.params.orderNumber });
  if (!order) throw new HttpError(404, 'Order not found');
  const done = await Order.findOneAndUpdate(
    { _id: order._id, 'refund.status': 'due' },
    { $set: { 'refund.status': 'done', 'refund.doneAt': new Date(), 'refund.note': req.body.note }, $unset: { needsAttention: 1 } },
    { new: true }
  );
  if (!done) throw new HttpError(409, 'There is no refund waiting on this order');
  notifyUser(order.user, {
    type: 'refund_sent',
    title: 'Refund sent',
    body: `We have refunded ₦${Number(done.refund.amount).toLocaleString('en-NG')} for order ${order.orderNumber}. It can take a few working days to show in your account.`,
    link: `/orders/${order.orderNumber}`,
  });
  res.json({ ok: true });
});

// Permanently delete a cancelled order. Only when it is really cancelled and no refund is still owed.
router.delete('/orders/:orderNumber', async (req, res) => {
  const order = await Order.findOne({ orderNumber: req.params.orderNumber });
  if (!order) throw new HttpError(404, 'Order not found');
  const shipments = await Shipment.find({ order: order._id }).select('status');
  const cancelled = order.paymentStatus === 'cancelled' || (Boolean(order.cancelledAt) && shipments.every((s) => s.status === 'cancelled'));
  if (!cancelled && order.paymentStatus !== 'failed') throw new HttpError(409, 'Only a cancelled order can be deleted');
  if (order.refund?.status === 'due') throw new HttpError(409, 'A refund is still owed on this order. Refund it first, then delete');
  await Shipment.deleteMany({ order: order._id });
  await order.deleteOne();
  res.json({ ok: true });
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

// Settles a problem a customer reported: 'release' pays the vendor, 'refund' takes their earnings back.
router.post('/shipments/:id/dispute', validate(z.object({ resolution: z.enum(['release', 'refund']), note: z.string().trim().max(300).optional() })), async (req, res) => {
  const shipment = await Shipment.findById(req.params.id);
  if (!shipment) throw new HttpError(404, 'Shipment not found');
  res.json(await resolveDispute(shipment, req.body.resolution, req.body.note));
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
