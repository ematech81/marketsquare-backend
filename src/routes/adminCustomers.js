const router = require('express').Router();
const Order = require('../models/Order');
const User = require('../models/User');
const { protect, requireRole } = require('../middleware/auth');

router.use(protect, requireRole('admin'));

// Everyone with a customer or vendor account, with what they have bought.
router.get('/customers', async (req, res) => {
  const [users, totals] = await Promise.all([
    User.find({ role: { $in: ['customer', 'vendor'] } }).sort({ createdAt: -1 }).limit(500),
    Order.aggregate([
      { $match: { paymentStatus: 'paid' } },
      { $group: { _id: '$user', orders: { $sum: 1 }, spent: { $sum: '$total' }, last: { $max: '$createdAt' } } },
    ]),
  ]);
  const byUser = new Map(totals.map((t) => [String(t._id), t]));
  res.json({
    customers: users.map((u) => {
      const t = byUser.get(String(u._id));
      return {
        id: u._id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        joinedAt: u.createdAt,
        orders: t?.orders ?? 0,
        spent: t?.spent ?? 0,
        lastOrderAt: t?.last ?? null,
      };
    }),
  });
});

module.exports = router;
