const Vendor = require('../models/Vendor');
const Shipment = require('../models/Shipment');
const WalletTransaction = require('../models/WalletTransaction');
const HttpError = require('../utils/httpError');
const { getStoreSettings } = require('./storeSettings');
const { notifyUser } = require('./notifications');

const isDuplicate = (err) => err && err.code === 11000;
const DAY = 86400000;
// A vendor's first deliveries wait a little longer, while they have no track record (Etsy does the same for new shops).
const NEW_VENDOR_DELIVERIES = 3;

// What a shipment's items add up to. Delivery fees are not part of this: Square Market takes no commission on them.
function grossOf(shipment) {
  return shipment.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

// How the vendor's money works:
//
//   1. A customer pays Square Market (KoraPay). The money sits with Square Market the whole time.
//   2. The shipment is delivered. The vendor earns: items total, minus Square Market's commission, plus the delivery
//      fee when the vendor delivered it themselves. This goes to their PENDING balance.
//   3. After the protection period (default 7 days, longer for a new vendor), it moves to their AVAILABLE balance,
//      and they can ask for a payout. If the customer reported a problem, it stays put until the admin decides.
//
// creditForDelivery does step 2 and is safe to call twice: the unique index lets only the first credit through.
async function creditForDelivery(shipment) {
  if (!shipment.vendor) return null; // the store's own products have no vendor wallet
  const vendor = await Vendor.findById(shipment.vendor);
  if (!vendor) return null;

  if (await WalletTransaction.exists({ shipment: shipment._id, type: 'sale' })) return null; // already credited

  const settings = await getStoreSettings();
  const gross = grossOf(shipment);
  const rate = vendor.commissionRate ?? settings.defaultCommissionRate;
  const commission = Math.round((gross * rate) / 100);
  // When the vendor delivered it, the delivery fee the customer paid is theirs.
  const deliveryFee = shipment.fulfilledBy === 'vendor' ? shipment.deliveryFee : 0;
  const net = gross - commission + deliveryFee;

  const earlier = await Shipment.countDocuments({ vendor: vendor._id, status: 'delivered', _id: { $ne: shipment._id } });
  const holdDays = settings.payoutHoldDays + (earlier < NEW_VENDOR_DELIVERIES ? settings.newVendorExtraHoldDays : 0);
  const now = new Date();
  const releaseAt = new Date(now.getTime() + holdDays * DAY);

  try {
    await WalletTransaction.create({ vendor: vendor._id, type: 'sale', amount: gross, shipment: shipment._id, note: `Sale, ${rate}% commission` });
  } catch (err) {
    if (isDuplicate(err)) return null; // already credited
    throw err;
  }
  if (commission > 0) await WalletTransaction.create({ vendor: vendor._id, type: 'commission', amount: -commission, shipment: shipment._id });
  if (deliveryFee > 0) {
    await WalletTransaction.create({ vendor: vendor._id, type: 'delivery_fee', amount: deliveryFee, shipment: shipment._id, note: 'Delivery fee for an order you delivered' });
  }

  await Vendor.updateOne({ _id: vendor._id }, { $inc: { pendingBalance: net } });
  await Shipment.updateOne({ _id: shipment._id }, { $set: { earning: { gross, commission, deliveryFee, net, creditedAt: now, releaseAt } } });
  shipment.earning = { gross, commission, deliveryFee, net, creditedAt: now, releaseAt };

  // With no waiting period, it is available straight away.
  if (holdDays === 0) await releaseOne(shipment._id);
  return { gross, commission, deliveryFee, net, releaseAt };
}

// Moves one shipment's earnings from pending to available. Claiming it first (releasedAt) makes this safe to run twice.
async function releaseOne(shipmentId) {
  const claimed = await Shipment.findOneAndUpdate(
    {
      _id: shipmentId,
      'earning.net': { $exists: true },
      'earning.releasedAt': { $exists: false },
      'earning.reversedAt': { $exists: false },
      'dispute.status': { $ne: 'open' },
    },
    { $set: { 'earning.releasedAt': new Date() } },
    { new: true }
  );
  if (!claimed) return null;
  const { net } = claimed.earning;
  await Vendor.updateOne({ _id: claimed.vendor }, { $inc: { pendingBalance: -net, walletBalance: net } });
  await WalletTransaction.create({ vendor: claimed.vendor, type: 'release', amount: net, shipment: claimed._id, note: 'Available for payout' }).catch((err) => {
    if (!isDuplicate(err)) throw err;
  });
  const owner = await Vendor.findById(claimed.vendor).select('user');
  notifyUser(owner?.user, {
    type: 'earnings_released',
    title: 'Earnings available',
    body: `₦${Number(net).toLocaleString('en-NG')} from an order is now available for payout.`,
    link: '/wallet',
  });
  return net;
}

// Releases everything whose protection period is over. Runs every few minutes, and whenever a vendor opens their wallet.
async function releaseDueEarnings({ vendorId } = {}) {
  const filter = {
    'earning.net': { $exists: true },
    'earning.releasedAt': { $exists: false },
    'earning.reversedAt': { $exists: false },
    'earning.releaseAt': { $lte: new Date() },
    'dispute.status': { $ne: 'open' },
  };
  if (vendorId) filter.vendor = vendorId;
  const due = await Shipment.find(filter).select('_id');
  let released = 0;
  for (const s of due) {
    if (await releaseOne(s._id)) released += 1;
  }
  return released;
}

// After a return or refund: take back what was credited for this shipment, once.
// Money still waiting is taken from the pending balance; money already released from the available balance.
async function reverseCredit(shipment) {
  if (!shipment.vendor) throw new HttpError(400, 'This shipment has no vendor credit to take back');
  const sale = await WalletTransaction.findOne({ shipment: shipment._id, type: 'sale' });
  if (!sale) throw new HttpError(409, 'This shipment was never credited to the vendor');
  if (await WalletTransaction.exists({ shipment: shipment._id, type: 'refund' })) {
    throw new HttpError(409, 'The credit for this shipment was already taken back');
  }
  const fresh = await Shipment.findById(shipment._id);
  const net = fresh.earning?.net ?? sale.amount;

  try {
    await WalletTransaction.create({ vendor: shipment.vendor, type: 'refund', amount: -net, shipment: shipment._id, note: 'Credit taken back after a refund' });
  } catch (err) {
    if (isDuplicate(err)) throw new HttpError(409, 'The credit for this shipment was already taken back');
    throw err;
  }
  // Claim it, so the release job can never pay it out afterwards.
  const before = await Shipment.findOneAndUpdate({ _id: shipment._id }, { $set: { 'earning.reversedAt': new Date() } }, { new: false });
  const alreadyReleased = Boolean(before?.earning?.releasedAt);
  await Vendor.updateOne({ _id: shipment.vendor }, { $inc: alreadyReleased ? { walletBalance: -net } : { pendingBalance: -net } });
  return net;
}

module.exports = { creditForDelivery, releaseDueEarnings, releaseOne, reverseCredit, grossOf };
