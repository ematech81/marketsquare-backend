const mongoose = require('mongoose');

// Every change to a vendor's wallet. Amounts are signed: money in is positive, money out is negative.
const walletTransactionSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    type: { type: String, enum: ['sale', 'commission', 'delivery_fee', 'release', 'payout', 'payout_reversal', 'refund'], required: true },
    amount: { type: Number, required: true },
    shipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment' },
    payout: { type: mongoose.Schema.Types.ObjectId, ref: 'PayoutRequest' },
    note: String,
  },
  { timestamps: true }
);

// A shipment can only ever be credited (or refunded) once, even if two requests race.
walletTransactionSchema.index(
  { shipment: 1, type: 1 },
  { unique: true, partialFilterExpression: { shipment: { $exists: true } } }
);

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
