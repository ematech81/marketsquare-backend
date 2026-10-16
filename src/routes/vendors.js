const router = require('express').Router();
const { z } = require('zod');
const Vendor = require('../models/Vendor');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const HttpError = require('../utils/httpError');
const { findOrCreateCategory } = require('../services/categories');
const { notifyAdmins } = require('../services/notifications');
const { categoryLimiter } = require('../middleware/rateLimit');

const text = (label) => z.string().trim().min(2, `Enter ${label}`);

// Each ID has its own shape. A NIN is exactly 11 digits. The others differ in length, so they only need to
// look like an ID: 6 to 20 letters and numbers.
const checkId = (v, ctx) => {
  if (v.idType === 'nin') {
    if (!/^\d{11}$/.test(v.idNumber)) ctx.addIssue({ code: 'custom', path: ['idNumber'], message: 'A NIN must be exactly 11 digits' });
  } else if (!/^[A-Za-z0-9-]{6,20}$/.test(v.idNumber)) {
    ctx.addIssue({ code: 'custom', path: ['idNumber'], message: 'Enter a valid ID number (6 to 20 letters and numbers)' });
  }
};

const applySchema = z.object({
  businessName: text('your business name'),
  category: text('a category'),
  state: text('your state'),
  city: text('your city'),
  phone: z.string().trim().regex(/^(\+234|0)\d{10}$/, 'Enter a valid Nigerian phone number'),
  rcNumber: z.string().trim().optional(),
  idType: z.enum(['nin', 'drivers_license', 'passport', 'voters_card'], { message: 'Choose an ID type' }),
  idNumber: z.string().transform((x) => x.replace(/\s+/g, '')).pipe(text('your ID number')),
  bank: z.object({
    bankName: text('your bank name'),
    accountNumber: z.string().trim().regex(/^\d{10}$/, 'Account number must be 10 digits'),
    accountName: text('your account name'),
  }),
}).superRefine(checkId);

// A signed-in customer applies to become a vendor. Stays pending until an admin approves.
router.post('/apply', protect, requireRole('customer'), categoryLimiter, validate(applySchema), async (req, res) => {
  if (await Vendor.exists({ user: req.user._id })) {
    throw new HttpError(409, 'You have already applied to sell on Square Market');
  }
  // A category that is not in the list yet is added to the shared list.
  const { category } = await findOrCreateCategory(req.body.category);
  const vendor = await Vendor.create({ ...req.body, category: category.name, user: req.user._id });
  notifyAdmins({ type: 'admin_vendor_application', title: 'New vendor application', body: vendor.businessName, link: '/vendors' });
  res.status(201).json({ vendor });
});

router.get('/me', protect, async (req, res) => {
  const vendor = await Vendor.findOne({ user: req.user._id });
  if (!vendor) throw new HttpError(404, 'No vendor application found');
  res.json({ vendor });
});

// A rejected applicant can fix the details and apply again.
router.put('/me', protect, validate(applySchema), async (req, res) => {
  const vendor = await Vendor.findOne({ user: req.user._id });
  if (!vendor) throw new HttpError(404, 'No vendor application found');
  if (vendor.status !== 'rejected') throw new HttpError(409, 'Only rejected applications can be resubmitted');

  const { category } = await findOrCreateCategory(req.body.category);
  notifyAdmins({ type: 'admin_vendor_application', title: 'Vendor application sent again', body: req.body.businessName, link: '/vendors' });
  vendor.set({ ...req.body, category: category.name, status: 'pending', rejectionReason: undefined, reviewedAt: undefined });
  await vendor.save();
  res.json({ vendor });
});

module.exports = router;
