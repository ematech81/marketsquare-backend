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
const { notifyUser } = require('../services/notifications');
const { getStoreSettings, saveStoreSettings } = require('../services/storeSettings');

router.use(protect, requireRole('admin'));

// ---------- Store rules (commission, payouts, listing approval) ----------

router.get('/settings', async (req, res) => {
  res.json({ settings: await getStoreSettings() });
});

const settingsSchema = z.object({
  defaultCommissionRate: z.number().min(0, 'Commission cannot be negative').max(100, 'Commission cannot be more than 100%'),
  minPayoutAmount: z.number().int('Use a whole number of Naira').min(0),
  requireListingApproval: z.boolean().optional(),
  listingReviewMode: z.enum(['all', 'smart', 'none']).optional(),
  provenAfterApprovals: z.number().int('Use a whole number').min(1).max(50).optional(),
  codEnabled: z.boolean().optional(),
  codMaxAmount: z.number().int('Use a whole number of Naira').min(0).optional(),
  payoutHoldDays: z.number().int('Use a whole number of days').min(0).max(60).optional(),
  newVendorExtraHoldDays: z.number().int('Use a whole number of days').min(0).max(60).optional(),
});

// How this vendor's listings are checked: 'auto' follows the store's setting, 'always' checks every listing,
// 'trusted' lets them publish straight away. An 18+ product is always checked.
router.patch('/vendors/:id/listing-review', validate(z.object({ mode: z.enum(['auto', 'always', 'trusted']) })), async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) throw new HttpError(404, 'Vendor not found');
  vendor.listingReview = req.body.mode;
  await vendor.save();
  res.json({ vendor });
});

// Stops a vendor from delivering their own orders (or lets them again). A vendor who was delivering goes back to Square Market.
router.patch('/vendors/:id/delivery', validate(z.object({ locked: z.boolean() })), async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) throw new HttpError(404, 'Vendor not found');
  vendor.deliveryLocked = req.body.locked;
  if (req.body.locked) vendor.deliveryMode = 'platform';
  await vendor.save();
  res.json({ vendor });
});

router.put('/settings', validate(settingsSchema), async (req, res) => {
  const body = { ...req.body };
  // The old on/off switch still works: on means every listing is checked, off means none.
  if (body.listingReviewMode === undefined && body.requireListingApproval !== undefined) {
    body.listingReviewMode = body.requireListingApproval ? 'all' : 'none';
  }
  if (body.listingReviewMode !== undefined) body.requireListingApproval = body.listingReviewMode !== 'none';
  res.json({ settings: await saveStoreSettings(body) });
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
    product.approvedAt = new Date();
  }
  await product.save();

  const vendor = await Vendor.findById(product.vendor);
  const owner = vendor && (await User.findById(vendor.user));
  if (owner) emails.productReview(product, owner, decision, reason);
  if (owner) {
    notifyUser(owner._id, {
      type: decision === 'approve' ? 'product_approved' : 'product_rejected',
      title: decision === 'approve' ? 'Your product is live' : 'Your product needs changes',
      body: decision === 'approve' ? product.title : `${product.title}: ${reason}`,
      link: '/products',
    });
  }

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
  if (owner) {
    notifyUser(owner._id, {
      type: status === 'paid' ? 'payout_paid' : 'payout_rejected',
      title: status === 'paid' ? 'Your payout was sent' : 'Your payout request was not approved',
      body: status === 'paid' ? `₦${Number(payout.amount).toLocaleString('en-NG')} is on its way to your bank account.` : `${reason}. The money is back in your wallet.`,
      link: '/wallet',
    });
  }

  res.json({ payout });
});

module.exports = router;
