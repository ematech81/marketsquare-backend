const router = require('express').Router();
const { z } = require('zod');
const PayoutRequest = require('../models/PayoutRequest');
const Product = require('../models/Product');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const WalletTransaction = require('../models/WalletTransaction');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const HttpError = require('../utils/httpError');
const emails = require('../services/emails');
const { getStoreSettings, saveStoreSettings } = require('../services/storeSettings');

router.use(protect, requireRole('admin'));

// ---------- Store rules (commission, payouts, listing approval) ----------

router.get('/settings', async (req, res) => {
  res.json({ settings: await getStoreSettings() });
});

const settingsSchema = z.object({
  defaultCommissionRate: z.number().min(0, 'Commission cannot be negative').max(100, 'Commission cannot be more than 100%'),
  minPayoutAmount: z.number().int('Use a whole number of Naira').min(0),
  requireListingApproval: z.boolean(),
});

router.put('/settings', validate(settingsSchema), async (req, res) => {
  res.json({ settings: await saveStoreSettings(req.body) });
});

// A vendor's own commission rate. null goes back to the store's default rate.
router.patch(
  '/vendors/:id/commission',
  validate(z.object({ commissionRate: z.number().min(0).max(100).nullable() })),
  async (req, res) => {
    const vendor = await Vendor.findByIdAndUpdate(req.params.id, { commissionRate: req.body.commissionRate }, { new: true });
    if (!vendor) throw new HttpError(404, 'Vendor not found');
    res.json({ vendor });
  }
);

// ---------- Reviewing vendors' listings ----------

const reviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().optional(),
});

router.patch('/products/:id/review', validate(reviewSchema), async (req, res) => {
  const { decision, reason } = req.body;
  const product = await Product.findById(req.params.id);
  if (!product) throw new HttpError(404, 'Product not found');
  if (!product.vendor) throw new HttpError(400, 'Only a vendor\'s listing needs review');
  if (product.status !== 'pending') throw new HttpError(409, 'This listing is not waiting for review');

  if (decision === 'reject') {
    if (!reason) throw new HttpError(400, 'reason: Tell the vendor what to fix');
    product.status = 'rejected';
    product.rejectionReason = reason;
  } else {
    if (product.images.length === 0) throw new HttpError(400, 'This listing has no images');
    product.status = 'active';
    product.rejectionReason = undefined;
  }
  await product.save();

  const vendor = await Vendor.findById(product.vendor);
  const owner = vendor && (await User.findById(vendor.user));
  if (owner) emails.productReview(product, owner, decision, reason);

  res.json({ product });
});

// ---------- Vendor payouts ----------

router.get('/payouts', async (req, res) => {
  const filter = req.query.status ? { status: String(req.query.status) } : {};
  const payouts = await PayoutRequest.find(filter).populate('vendor', 'businessName phone').sort({ createdAt: -1 }).limit(200);
  res.json({ payouts });
});

const payoutSchema = z.object({
  status: z.enum(['paid', 'rejected']),
  reference: z.string().trim().optional(),
  reason: z.string().trim().optional(),
});

// Mark a payout as paid (after you have sent the money), or turn it down and return the money to the wallet.
router.patch('/payouts/:id', validate(payoutSchema), async (req, res) => {
  const { status, reference, reason } = req.body;
  if (status === 'rejected' && !reason) throw new HttpError(400, 'reason: Tell the vendor why');

  // Only a request that is still waiting can be decided, and only once.
  const payout = await PayoutRequest.findOneAndUpdate(
    { _id: req.params.id, status: 'requested' },
    status === 'paid'
      ? { status, paidAt: new Date(), reference }
      : { status, rejectionReason: reason },
    { new: true }
  );
  if (!payout) throw new HttpError(409, 'This payout was already decided, or does not exist');

  if (status === 'rejected') {
    await Vendor.updateOne({ _id: payout.vendor }, { $inc: { walletBalance: payout.amount } });
    await WalletTransaction.create({ vendor: payout.vendor, type: 'payout_reversal', amount: payout.amount, payout: payout._id, note: reason });
  }

  const vendor = await Vendor.findById(payout.vendor);
  const owner = vendor && (await User.findById(vendor.user));
  if (owner) emails.payoutUpdate(vendor, owner, payout);

  res.json({ payout });
});

module.exports = router;
