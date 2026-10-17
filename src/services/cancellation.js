const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const HttpError = require('../utils/httpError');
const { moveShipment } = require('./shipments');
const { notifyUser, notifyAdmins } = require('./notifications');
const { sendMail } = require('./mailer');

const REASONS = ['Changed my mind', 'Ordered by mistake', 'Found a better price', 'Delivery would take too long', 'Need to change the address or items', 'Other'];

const money = (n) => `₦${Number(n).toLocaleString('en-NG')}`;

// A customer may cancel while Square Market and the vendors have not started packing:
//   - an order still waiting for payment: any time (nothing was paid);
//   - a paid or pay-on-delivery order: while every package is only "placed" or "confirmed", and nobody has reported a problem.
// Once something is packed or on its way, it is too late to cancel (they can refuse the delivery and ask for a return).
async function whyNotCancellable(order) {
  if (order.paymentStatus === 'cancelled' || order.cancelledAt) return 'This order is already cancelled.';
  if (order.paymentStatus === 'failed') return 'This order was never paid, so there is nothing to cancel.';
  if (order.paymentStatus === 'mismatch') return 'This order needs checking by Square Market. Please contact support.';
  if (order.paymentStatus === 'pending') return null;
  const shipments = await Shipment.find({ order: order._id });
  const live = shipments.filter((s) => s.status !== 'cancelled');
  if (live.length === 0) return 'This order is already cancelled.';
  if (live.some((s) => !['placed', 'confirmed'].includes(s.status))) {
    return 'Part of your order is already packed or on its way, so it can no longer be cancelled. When it arrives you can return it within the return period.';
  }
  if (live.some((s) => s.dispute?.status === 'open')) return 'You have reported a problem with this order, so it cannot be cancelled now.';
  return null;
}

// What is owed back to the customer after a paid online order is cancelled. Square Market refunds it by hand from the
// KoraPay dashboard, then marks it as refunded.
async function markRefundDue(order, amount) {
  await Order.updateOne({ _id: order._id }, { $set: { refund: { status: 'due', amount, dueAt: new Date() } } });
  notifyAdmins({
    type: 'admin_refund_due',
    title: 'Refund due',
    body: `Order ${order.orderNumber} was cancelled. Refund ${money(amount)} from your KoraPay dashboard, then mark it refunded.`,
    link: `/orders/${order.orderNumber}`,
  });
  sendMail({
    to: process.env.ADMIN_ALERT_EMAIL,
    subject: `Refund due: order ${order.orderNumber} (${money(amount)})`,
    text: `Order ${order.orderNumber} was cancelled after the customer paid ${money(amount)}. Refund it from your KoraPay dashboard, then open the order in the dashboard and mark it as refunded.`,
    html: `<p>Order ${order.orderNumber} was cancelled after the customer paid ${money(amount)}. Refund it from your KoraPay dashboard, then open the order in the dashboard and mark it as refunded.</p>`,
  });
}

// Tells each vendor whose items were in the order, so they stop packing.
async function tellVendors(order, who) {
  const ids = [...new Set(order.items.filter((i) => i.vendor).map((i) => String(i.vendor)))];
  if (ids.length === 0) return;
  const vendors = await Vendor.find({ _id: { $in: ids } }).select('user businessName');
  for (const v of vendors) {
    notifyUser(v.user, {
      type: 'vendor_order_cancelled',
      title: `Order ${order.orderNumber} was cancelled`,
      body: `${who} cancelled it. Please do not pack or ship it.`,
      link: '/orders',
    });
  }
}

// Cancels every package that has not been delivered, puts the stock back, and records any refund.
async function cancelOrder(order, { by, reason, note }) {
  const cancelledAt = new Date();
  const base = { cancelledAt, cancelledBy: by, cancelReason: reason, cancelNote: note || undefined };

  if (order.paymentStatus === 'pending') {
    // Nothing was paid. Claiming it while it is still pending stops a late payment from ever being processed.
    const claimed = await Order.findOneAndUpdate({ _id: order._id, paymentStatus: 'pending' }, { $set: { ...base, paymentStatus: 'cancelled' } }, { new: true });
    if (!claimed) throw new HttpError(409, 'This order just changed. Please refresh and try again.');
    return claimed;
  }

  const shipments = await Shipment.find({ order: order._id });
  for (const s of shipments) {
    if (s.status === 'cancelled') continue;
    if (s.status === 'delivered') throw new HttpError(409, 'Part of this order was already delivered, so it cannot be cancelled as a whole.');
    // `silent`: one "your order was cancelled" message is sent below, not one per package.
    await moveShipment(s, 'cancelled', ['cancelled'], { by: by === 'admin' ? 'admin' : 'customer', silent: true });
  }
  await Order.updateOne({ _id: order._id }, { $set: base });

  const fresh = await Order.findById(order._id);
  // An online payment must be refunded. Pay on delivery has taken no money.
  if (fresh.paymentStatus === 'paid' && fresh.paymentMethod === 'online') await markRefundDue(fresh, fresh.paidAmount ?? fresh.total);

  const user = await User.findById(order.user);
  if (user) {
    notifyUser(user._id, {
      type: 'order_cancelled',
      title: 'Order cancelled',
      body:
        fresh.paymentStatus === 'paid' && fresh.paymentMethod === 'online'
          ? `Order ${order.orderNumber} is cancelled. We will refund ${money(fresh.paidAmount ?? fresh.total)} to you.`
          : `Order ${order.orderNumber} is cancelled.`,
      link: `/orders/${order.orderNumber}`,
    });
  }
  await tellVendors(order, by === 'admin' ? 'Square Market' : 'The customer');
  if (by === 'customer') {
    notifyAdmins({ type: 'admin_order_cancelled', title: 'A customer cancelled an order', body: `Order ${order.orderNumber}: ${reason}`, link: `/orders/${order.orderNumber}` });
  }
  return fresh;
}

module.exports = { REASONS, whyNotCancellable, cancelOrder };
