const router = require('express').Router();
const { z } = require('zod');
const PayoutRequest = require('../models/PayoutRequest');
const Product = require('../models/Product');
const Shipment = require('../models/Shipment');
const Vendor = require('../models/Vendor');
const WalletTransaction = require('../models/WalletTransaction');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { requireVendor } = require('../middleware/vendor');
const HttpError = require('../utils/httpError');
const { getStoreSettings } = require('../services/storeSettings');
const { sendMail } = require('../services/mailer');

router.use(protect, requireVendor);

const { notifyAdmins } = require('../services/notifications');
const naira = (n) => `₦${Number(n).toLocaleString('en-NG')}`;

// Numbers for the vendor's dashboard home.
router.get('/overview', async (req, res) => {
  const vendor = await Vendor.findById(req.vendor._id);
  const [shipments, products, sales] = await Promise.all([
    Shipment.find({ vendor: vendor._id }).select('status'),
    Product.aggregate([{ $match: { vendor: vendor._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    WalletTransaction.aggregate([{ $match: { vendor: vendor._id, type: 'sale' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);
  const byStatus = Object.fromEntries(products.map((p) => [p._id, p.count]));
  res.json({
    businessName: vendor.businessName,
    balance: vendor.walletBalance,
    sales: sales[0]?.total ?? 0,
    toConfirm: shipments.filter((s) => s.status === 'placed').length,
    openOrders: shipments.filter((s) => ['placed', 'confirmed', 'packed', 'shipped'].includes(s.status)).length,
    products: { live: byStatus.active ?? 0, pending: byStatus.pending ?? 0, draft: byStatus.draft ?? 0, rejected: byStatus.rejected ?? 0 },
  });
});

router.get('/wallet', async (req, res) => {
  const vendor = await Vendor.findById(req.vendor._id);
  const settings = await getStoreSettings();
  const [transactions, payouts] = await Promise.all([
    WalletTransaction.find({ vendor: vendor._id }).sort({ createdAt: -1 }).limit(50),
    PayoutRequest.find({ vendor: vendor._id }).sort({ createdAt: -1 }).limit(20),
  ]);
  res.json({
    balance: vendor.walletBalance,
    minPayoutAmount: settings.minPayoutAmount,
    commissionRate: vendor.commissionRate ?? settings.defaultCommissionRate,
    bank: vendor.bank,
    transactions,
    payouts,
  });
});

// Asking for a payout takes the money out of the wallet straight away, so it cannot be asked for twice.
// If the admin turns the request down, it goes back.
router.post('/payouts', validate(z.object({ amount: z.number().int('Enter a whole number of Naira').positive('Enter an amount') })), async (req, res) => {
  const { amount } = req.body;
  const settings = await getStoreSettings();
  if (amount < settings.minPayoutAmount) throw new HttpError(400, `The smallest payout is ${naira(settings.minPayoutAmount)}`);

  const vendor = await Vendor.findOneAndUpdate(
    { _id: req.vendor._id, walletBalance: { $gte: amount } },
    { $inc: { walletBalance: -amount } },
    { new: true }
  );
  if (!vendor) throw new HttpError(409, 'You do not have that much available in your wallet');

  let payout;
  try {
    payout = await PayoutRequest.create({
      vendor: vendor._id,
      amount,
      bank: { bankName: vendor.bank.bankName, accountNumber: vendor.bank.accountNumber, accountName: vendor.bank.accountName },
    });
    await WalletTransaction.create({ vendor: vendor._id, type: 'payout', amount: -amount, payout: payout._id });
  } catch (err) {
    await Vendor.updateOne({ _id: vendor._id }, { $inc: { walletBalance: amount } });
    throw err;
  }

  sendMail({
    to: process.env.ADMIN_ALERT_EMAIL,
    subject: `Payout request: ${vendor.businessName} ${naira(amount)}`,
    text: `${vendor.businessName} asked to be paid ${naira(amount)}. Open the dashboard, go to Payouts, pay them, then mark it as paid.`,
    html: `<p>${vendor.businessName} asked to be paid ${naira(amount)}. Open the dashboard, go to Payouts, pay them, then mark it as paid.</p>`,
  });
  notifyAdmins({ type: 'admin_payout_request', title: 'Payout requested', body: `${vendor.businessName} asked for ${naira(amount)}.`, link: '/payouts' });
  res.status(201).json({ payout, balance: vendor.walletBalance });
});

module.exports = router;
