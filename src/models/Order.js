const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    title: { type: String, required: true },
    image: String,
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    options: [{ name: String, value: String, _id: false }],
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orderNumber: { type: String, required: true, unique: true },
    items: [lineSchema],
    address: {
      fullName: { type: String, required: true },
      phone: { type: String, required: true },
      street: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
      landmark: String,
    },
    // The email KoraPay sends the receipt to. Defaults to the account email.
    contactEmail: String,
    subtotal: { type: Number, required: true },
    // One delivery fee per seller, as the plan describes. Used to build shipments once paid.
    deliveries: [
      {
        vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
        fee: Number,
        estimatedDays: Number,
        _id: false,
      },
    ],
    deliveryTotal: { type: Number, required: true },
    total: { type: Number, required: true },
    currency: { type: String, required: true },
    // The webhook finds the order by this field, never by _id.
    checkoutReference: { type: String, required: true, unique: true },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'mismatch'], default: 'pending', index: true },
    paidAt: Date,
    paidAmount: Number,
    // Set when payment succeeded but something needs a person to look at it (stock ran out, amount differed).
    needsAttention: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
