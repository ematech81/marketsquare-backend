const router = require('express').Router();
const { z } = require('zod');
const Vendor = require('../models/Vendor');
const User = require('../models/User');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const HttpError = require('../utils/httpError');
const emails = require('../services/emails');
const { notifyUser } = require('../services/notifications');

router.use(protect, requireRole('admin'));

router.get('/vendors', async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  const vendors = await Vendor.find(filter).populate('user', 'name email phone').sort({ createdAt: -1 });
  res.json({ vendors });
});

router.get('/vendors/:id', async (req, res) => {
  const vendor = await Vendor.findById(req.params.id).populate('user', 'name email phone');
  if (!vendor) throw new HttpError(404, 'Vendor not found');
  res.json({ vendor });
});

const decisionSchema = z.object({
  status: z.enum(['approved', 'rejected', 'suspended']),
  reason: z.string().trim().optional(),
  commissionRate: z.number().min(0).max(100).nullable().optional(),
});

router.patch('/vendors/:id/status', validate(decisionSchema), async (req, res) => {
  const { status, reason, commissionRate } = req.body;
  if (status === 'rejected' && !reason) throw new HttpError(400, 'reason: Give the applicant a reason');

  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) throw new HttpError(404, 'Vendor not found');

  vendor.status = status;
  vendor.rejectionReason = status === 'rejected' ? reason : undefined;
  vendor.reviewedAt = new Date();
  if (commissionRate !== undefined) vendor.commissionRate = commissionRate;
  await vendor.save();

  // Approved vendors get the vendor role; everyone else is a plain customer.
  await User.findByIdAndUpdate(vendor.user, { role: status === 'approved' ? 'vendor' : 'customer' });

  const applicant = await User.findById(vendor.user);
  if (applicant) emails.vendorDecision(vendor, applicant, status, reason);
  notifyUser(vendor.user, {
    type: `vendor_${status}`,
    title: status === 'approved' ? 'Your vendor application is approved' : status === 'rejected' ? 'Your vendor application was not approved' : 'Your vendor account was updated',
    body: status === 'approved' ? 'You can now list products from your vendor dashboard.' : status === 'rejected' ? reason : undefined,
    link: status === 'rejected' ? '/become-a-vendor' : '/',
  });

  res.json({ vendor });
});

module.exports = router;
