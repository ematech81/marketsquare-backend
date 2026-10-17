const router = require('express').Router();
const crypto = require('crypto');
const Order = require('../models/Order');
const korapay = require('../services/korapay');
const { markOrderPaid } = require('../services/orders');
const { notifyAdmins } = require('../services/notifications');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Server-to-server: the shared KoraPay router calls this, not a signed-in user, so there is no auth middleware.
router.post('/korapay', async (req, res) => {
  // Optional extra layer: the router adds x-router-secret. Skipped when we have no secret configured.
  const routerSecret = process.env.ROUTER_FORWARD_SECRET;
  if (routerSecret && !safeEqual(req.headers['x-router-secret'] ?? '', routerSecret)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  // The real proof of origin: KoraPay's signature over the data object.
  const { event, data } = req.body ?? {};
  if (!data || !korapay.isValidSignature(data, req.headers['x-korapay-signature'])) {
    return res.status(401).json({ message: 'Invalid signature' });
  }

  if (event === 'charge.success' && data.status === 'success') {
    const order = await Order.findOne({ checkoutReference: data.reference });
    // An event for a reference we do not know: acknowledge so the router does not keep retrying it.
    if (!order) return res.status(200).json({ ok: true, ignored: true });
    // The customer cancelled, then paid anyway (for example from a payment page they left open). Nothing is shipped,
    // and the money must go back.
    if (order.paymentStatus === 'cancelled') {
      await Order.updateOne(
        { _id: order._id, 'refund.status': { $ne: 'done' } },
        { $set: { refund: { status: 'due', amount: Number(data.amount), dueAt: new Date() }, needsAttention: 'Paid after the order was cancelled. Refund it.' } }
      );
      notifyAdmins({
        type: 'admin_refund_due',
        title: 'Refund due',
        body: `Order ${order.orderNumber} was paid after it was cancelled. Refund ₦${Number(data.amount).toLocaleString('en-NG')}.`,
        link: `/orders/${order.orderNumber}`,
      });
      return res.status(200).json({ ok: true });
    }
    await markOrderPaid(order, data.amount);
  }

  res.status(200).json({ ok: true });
});

module.exports = router;
