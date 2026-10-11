const mongoose = require('mongoose');

const payoutRequestSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    // Where to pay, copied at request time so a later change to the vendor's details cannot redirect it.
    bank: { bankName: String, accountNumber: String, accountName: String },
    status: { type: String, enum: ['requested', 'paid', 'rejected'], default: 'requested', index: true },
    paidAt: Date,
    reference: String,
    rejectionReason: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('PayoutRequest', payoutRequestSchema);
