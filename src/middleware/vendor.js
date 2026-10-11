const Vendor = require('../models/Vendor');
const HttpError = require('../utils/httpError');

// Only an approved vendor gets through. Puts their vendor record on req.vendor. Use after protect.
async function requireVendor(req, res, next) {
  if (req.user.role !== 'vendor') throw new HttpError(403, 'This area is for approved vendors');
  const vendor = await Vendor.findOne({ user: req.user._id, status: 'approved' });
  if (!vendor) throw new HttpError(403, 'Your vendor account is not active');
  req.vendor = vendor;
  next();
}

module.exports = { requireVendor };
