const router = require('express').Router();
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const HttpError = require('../utils/httpError');

const publicStore = (vendor, productCount) => ({
  id: vendor._id,
  name: vendor.businessName,
  category: vendor.category,
  state: vendor.state,
  city: vendor.city,
  productCount,
});

// Approved vendors who have at least one live product. Nothing private (ID, bank, phone) is shown.
router.get('/stores', async (req, res) => {
  const counts = await Product.aggregate([{ $match: { status: 'active', vendor: { $ne: null } } }, { $group: { _id: '$vendor', count: { $sum: 1 } } }]);
  const countOf = new Map(counts.map((c) => [String(c._id), c.count]));
  const vendors = await Vendor.find({ status: 'approved', _id: { $in: counts.map((c) => c._id) } }).sort({ businessName: 1 });
  res.json({ stores: vendors.map((v) => publicStore(v, countOf.get(String(v._id)))) });
});

router.get('/stores/:id', async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new HttpError(404, 'Store not found');
  const vendor = await Vendor.findOne({ _id: req.params.id, status: 'approved' });
  if (!vendor) throw new HttpError(404, 'Store not found');
  const count = await Product.countDocuments({ vendor: vendor._id, status: 'active' });
  res.json({ store: publicStore(vendor, count) });
});

module.exports = router;
