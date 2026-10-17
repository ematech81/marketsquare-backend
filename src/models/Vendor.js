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
    // Money the vendor can ask to be paid out now.
    walletBalance: { type: Number, default: 0 },
    // Money earned from delivered orders that is still in its protection period. It becomes available on its release date.
    pendingBalance: { type: Number, default: 0 },
    // Who delivers this vendor's orders: Square Market ('platform') or the vendor ('self').
    // A vendor who delivers must set their own delivery fees for the states they serve.
    deliveryMode: { type: String, enum: ['platform', 'self'], default: 'platform' },
    // Set by the admin to stop a vendor from delivering their own orders.
    deliveryLocked: { type: Boolean, default: false },
    // How this vendor's listings are checked: 'auto' follows the store's setting, 'always' means every listing is checked,
    // 'trusted' means their listings go live straight away (18+ products are still checked).
    listingReview: { type: String, enum: ['auto', 'always', 'trusted'], default: 'auto' },
    deliveryRates: [{ state: { type: String, required: true }, fee: { type: Number, required: true, min: 0 }, estimatedDays: { type: Number, default: 3, min: 1, max: 30 }, _id: false }],
    reviewedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Vendor', vendorSchema);
