const Vendor = require('../models/Vendor');
const WalletTransaction = require('../models/WalletTransaction');
const HttpError = require('../utils/httpError');
const { getStoreSettings } = require('./storeSettings');

const isDuplicate = (err) => err && err.code === 11000;

// What a shipment's items add up to. Delivery fees are not the vendor's money.
function grossOf(shipment) {
  return shipment.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

// Called when a shipment is delivered: the vendor earns the items' total minus Square Market's commission.
// Safe to call twice: the unique index lets only the first credit through.
async function creditForDelivery(shipment) {
  if (!shipment.vendor) return null; // the store's own products have no vendor wallet
  const vendor = await Vendor.findById(shipment.vendor);
  if (!vendor) return null;

  if (await WalletTransaction.exists({ shipment: shipment._id, type: 'sale' })) return null; // already credited

  const gross = grossOf(shipment);
  const rate = vendor.commissionRate ?? (await getStoreSettings()).defaultCommissionRate;
  const commission = Math.round((gross * rate) / 100);

  try {
    await WalletTransaction.create({ vendor: vendor._id, type: 'sale', amount: gross, shipment: shipment._id, note: `Sale, ${rate}% commission` });
  } catch (err) {
    if (isDuplicate(err)) return null; // already credited
    throw err;
  }
  if (commission > 0) {
    await WalletTransaction.create({ vendor: vendor._id, type: 'commission', amount: -commission, shipment: shipment._id });
  }
  await Vendor.updateOne({ _id: vendor._id }, { $inc: { walletBalance: gross - commission } });
  return { gross, commission, net: gross - commission };
}

// After a return or refund: take back what was credited for this shipment, once.
async function reverseCredit(shipment) {
  if (!shipment.vendor) throw new HttpError(400, 'This shipment has no vendor credit to take back');
  const sale = await WalletTransaction.findOne({ shipment: shipment._id, type: 'sale' });
  if (!sale) throw new HttpError(409, 'This shipment was never credited to the vendor');
  if (await WalletTransaction.exists({ shipment: shipment._id, type: 'refund' })) {
    throw new HttpError(409, 'The credit for this shipment was already taken back');
  }
  const commission = await WalletTransaction.findOne({ shipment: shipment._id, type: 'commission' });
  const net = sale.amount + (commission?.amount ?? 0);

  try {
    await WalletTransaction.create({ vendor: shipment.vendor, type: 'refund', amount: -net, shipment: shipment._id, note: 'Credit taken back after a refund' });
  } catch (err) {
    if (isDuplicate(err)) throw new HttpError(409, 'The credit for this shipment was already taken back');
    throw err;
  }
  await Vendor.updateOne({ _id: shipment.vendor }, { $inc: { walletBalance: -net } });
  return net;
}

module.exports = { creditForDelivery, reverseCredit, grossOf };
