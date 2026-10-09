const router = require('express').Router();
const { z } = require('zod');
const Vendor = require('../models/Vendor');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const HttpError = require('../utils/httpError');

const text = (label) => z.string().trim().min(2, `Enter ${label}`);

const applySchema = z.object({
  businessName: text('your business name'),
  category: text('a category'),
  state: text('your state'),
  city: text('your city'),
  phone: z.string().trim().regex(/^(\+234|0)\d{10}$/, 'Enter a valid Nigerian phone number'),
  rcNumber: z.string().trim().optional(),
  idType: z.enum(['nin', 'drivers_license', 'passport', 'voters_card'], { message: 'Choose an ID type' }),
  idNumber: text('your ID number'),
  bank: z.object({
    bankName: text('your bank name'),
    accountNumber: z.string().trim().regex(/^\d{10}$/, 'Account number must be 10 digits'),
    accountName: text('your account name'),
  }),
});

// A signed-in customer applies to become a vendor. Stays pending until an admin approves.
router.post('/apply', protect, requireRole('customer'), validate(applySchema), async (req, res) => {
  if (await Vendor.exists({ user: req.user._id })) {
    throw new HttpError(409, 'You have already applied to sell on Square Market');
  }
  const vendor = await Vendor.create({ ...req.body, user: req.user._id });
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

  vendor.set({ ...req.body, status: 'pending', rejectionReason: undefined, reviewedAt: undefined });
  await vendor.save();
  res.json({ vendor });
});

module.exports = router;
