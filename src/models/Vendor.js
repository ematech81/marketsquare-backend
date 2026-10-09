const mongoose = require('mongoose');

const vendorSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    businessName: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    // Optional until the CAC question in the plan is settled.
    rcNumber: { type: String, trim: true },
    idType: { type: String, enum: ['nin', 'drivers_license', 'passport', 'voters_card'], required: true },
    idNumber: { type: String, required: true, trim: true },
    bank: {
      bankName: { type: String, required: true, trim: true },
      accountNumber: { type: String, required: true, trim: true },
      accountName: { type: String, required: true, trim: true },
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'suspended'],
      default: 'pending',
    },
    rejectionReason: { type: String, trim: true },
    // null means "use the platform default commission".
    commissionRate: { type: Number, min: 0, max: 100, default: null },
    walletBalance: { type: Number, default: 0 },
    reviewedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Vendor', vendorSchema);
