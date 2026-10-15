const router = require('express').Router();
const Order = require('../models/Order');
const Product = require('../models/Product');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const { protect, requireRole } = require('../middleware/auth');

router.use(protect, requireRole('admin'));

// Numbers and lists for the dashboard's Overview screen.
router.get('/overview', async (req, res) => {
  const [paid, orderCount, activeVendors, pendingVendors, productCount, customerCount, applications, recent] = await Promise.all([
    Order.aggregate([{ $match: { paymentStatus: 'paid' } }, { $group: { _id: null, sales: { $sum: '$total' }, count: { $sum: 1 } } }]),
    Order.countDocuments({ paymentStatus: { $in: ['paid', 'mismatch', 'cod'] } }),
    Vendor.countDocuments({ status: 'approved' }),
    Vendor.countDocuments({ status: 'pending' }),
    Product.countDocuments({ status: 'active' }),
    User.countDocuments({ role: 'customer' }),
    Vendor.find({ status: 'pending' }).populate('user', 'name email').sort({ createdAt: -1 }).limit(8),
    Order.find({ paymentStatus: { $ne: 'failed' } }).populate('user', 'name').sort({ createdAt: -1 }).limit(8),
  ]);

  const shipments = await Shipment.find({ order: { $in: recent.map((o) => o._id) } }).select('order status');
  const statusOf = (order) => {
    if (order.paymentStatus === 'pending') return 'Awaiting payment';
    if (order.paymentStatus === 'mismatch') return 'Needs attention';
    const s = shipments.filter((x) => String(x.order) === String(order._id)).map((x) => x.status);
    if (s.length > 0 && s.every((x) => x === 'delivered')) return 'Delivered';
    if (s.some((x) => x === 'shipped' || x === 'delivered')) return s.every((x) => x === 'shipped' || x === 'delivered') ? 'Shipped' : 'Partly shipped';
    if (s.some((x) => x === 'packed')) return 'Packed';
    return order.paymentStatus === 'cod' ? 'Pay on delivery' : 'Paid';
  };

  res.json({
    kpis: {
      sales: paid[0]?.sales ?? 0,
      orders: orderCount,
      activeVendors,
      applicationsToReview: pendingVendors,
      products: productCount,
      customers: customerCount,
    },
    applications,
    recentOrders: recent.map((o) => ({
      orderNumber: o.orderNumber,
      customer: o.user?.name ?? '-',
      total: o.total,
      status: statusOf(o),
      needsAttention: o.needsAttention,
      createdAt: o.createdAt,
    })),
  });
});

module.exports = router;
