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
    // An 18+ item. The delivery person checks ID.
    ageRestricted: { type: Boolean, default: false },
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
    // The buyer confirmed they are 18 or older (needed when the order has 18+ items).
    ageConfirmed: Boolean,
    // The email KoraPay sends the receipt to. Defaults to the account email.
    contactEmail: String,
    subtotal: { type: Number, required: true },
    // One delivery fee per seller, as the plan describes. Used to build shipments once paid.
    deliveries: [
      {
        vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
        fee: Number,
        estimatedDays: Number,
        // Who delivers this seller's items: Square Market ('platform') or the vendor ('vendor').
        mode: { type: String, enum: ['platform', 'vendor'], default: 'platform' },
        _id: false,
      },
    ],
    deliveryTotal: { type: Number, required: true },
    total: { type: Number, required: true },
    currency: { type: String, required: true },
    // The webhook finds the order by this field, never by _id.
    checkoutReference: { type: String, required: true, unique: true },
    // online: paid through KoraPay. cod: pay on delivery, the money is collected when the order arrives.
    paymentMethod: { type: String, enum: ['online', 'cod'], default: 'online' },
    // 'cod' means placed and waiting to be paid on delivery. It becomes 'paid' once the order has been delivered.
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'mismatch', 'cod', 'cancelled'], default: 'pending', index: true },
    paidAt: Date,
    paidAmount: Number,
    // 'cancelled' above is only for an order that was cancelled before anything was paid. A paid or pay-on-delivery
    // order keeps its payment status, and its packages are cancelled instead.
    cancelledAt: Date,
    cancelledBy: { type: String, enum: ['customer', 'admin'] },
    cancelReason: String,
    cancelNote: String,
    // Money owed back to the customer after a paid online order was cancelled. Refunded by hand from KoraPay.
    refund: {
      status: { type: String, enum: ['due', 'done'] },
      amount: Number,
      dueAt: Date,
      doneAt: Date,
      note: String,
    },
    // The customer removed this (cancelled) order from their list. Square Market keeps the record.
    hiddenByCustomer: { type: Boolean, default: false },
    // Set when payment succeeded but something needs a person to look at it (stock ran out, amount differed).
    needsAttention: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
