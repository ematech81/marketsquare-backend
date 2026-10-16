const router = require('express').Router();
const PayoutRequest = require('../models/PayoutRequest');
const Shipment = require('../models/Shipment');
const Vendor = require('../models/Vendor');
const { protect, requireRole } = require('../middleware/auth');
const { releaseDueEarnings } = require('../services/wallet');

router.use(protect, requireRole('admin'));

// What Square Market has earned in commission, and what it owes vendors. All of it comes from delivered shipments.
router.get('/earnings', async (req, res) => {
  await releaseDueEarnings();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // Only shipments that are still credited count: a refunded one is taken back.
  const counted = { 'earning.net': { $exists: true }, 'earning.reversedAt': { $exists: false } };
  const sum = (match) =>
    Shipment.aggregate([
      { $match: { ...counted, ...match } },
      { $group: { _id: null, commission: { $sum: '$earning.commission' }, gross: { $sum: '$earning.gross' }, count: { $sum: 1 } } },
    ]).then((r) => r[0] ?? { commission: 0, gross: 0, count: 0 });

  const [all, month, byVendor, balances, requested, disputes] = await Promise.all([
    sum({}),
    sum({ 'earning.creditedAt': { $gte: monthStart } }),
    Shipment.aggregate([
      { $match: { ...counted, vendor: { $ne: null } } },
      { $group: { _id: '$vendor', commission: { $sum: '$earning.commission' }, gross: { $sum: '$earning.gross' }, orders: { $sum: 1 } } },
    ]),
    Vendor.aggregate([
      { $group: { _id: null, pending: { $sum: '$pendingBalance' }, available: { $sum: '$walletBalance' } } },
    ]),
    PayoutRequest.aggregate([{ $match: { status: 'requested' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Shipment.countDocuments({ 'dispute.status': 'open' }),
  ]);

  const vendors = await Vendor.find({ status: 'approved' }).select('businessName walletBalance pendingBalance deliveryMode commissionRate');
  const stats = new Map(byVendor.map((v) => [String(v._id), v]));
  res.json({
    commission: { allTime: all.commission, thisMonth: month.commission },
    sales: { allTime: all.gross, thisMonth: month.gross, deliveredOrders: all.count },
    // What Square Market holds for vendors: not yet payable (pending) and payable now (available), including payouts already asked for.
    owed: { pending: balances[0]?.pending ?? 0, available: balances[0]?.available ?? 0, payoutsRequested: requested[0]?.total ?? 0, payoutsRequestedCount: requested[0]?.count ?? 0 },
    openDisputes: disputes,
    vendors: vendors
      .map((v) => ({
        id: v._id,
        name: v.businessName,
        deliveryMode: v.deliveryMode,
        commissionRate: v.commissionRate,
        pending: v.pendingBalance,
        available: v.walletBalance,
        sales: stats.get(String(v._id))?.gross ?? 0,
        commission: stats.get(String(v._id))?.commission ?? 0,
        orders: stats.get(String(v._id))?.orders ?? 0,
      }))
      .sort((a, b) => b.commission - a.commission),
  });
});

module.exports = router;
