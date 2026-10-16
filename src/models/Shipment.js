const mongoose = require('mongoose');

const shipmentSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    items: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        title: String,
        image: String,
        price: Number,
        quantity: Number,
        options: [{ name: String, value: String, _id: false }],
        // True when this line's stock was taken at payment, so cancelling puts it back exactly once.
        stockTaken: { type: Boolean, default: false },
        _id: false,
      },
    ],
    deliveryFee: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['placed', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'],
      default: 'placed',
    },
    timeline: [{ status: String, at: Date, _id: false }],
    estimatedDelivery: Date,
    // Who delivers it. Decided when the order is placed and never changed after.
    fulfilledBy: { type: String, enum: ['platform', 'vendor'], default: 'platform' },
    // Filled in by the vendor when they ship their own delivery.
    delivery: {
      courierName: String,
      courierPhone: String,
      note: String,
      shippedAt: Date,
    },
    // A 6-digit code made when a vendor-delivered shipment is shipped. The customer sees it and gives it to the person
    // delivering, who enters it to mark the order delivered. It proves the goods reached the customer.
    deliveryCode: { type: String },
    codeAttempts: { type: Number, default: 0 },
    deliveredBy: { type: String, enum: ['code', 'customer', 'admin'] },
    // What the vendor earns from this shipment, and when it can be paid out.
    earning: {
      gross: Number,
      commission: Number,
      deliveryFee: Number,
      net: Number,
      creditedAt: Date,
      releaseAt: Date,
      releasedAt: Date,
      // Money taken back after a refund
      reversedAt: Date,
    },
    // A problem the customer reported. While it is open, the vendor's money is not released.
    dispute: {
      status: { type: String, enum: ['open', 'released', 'refunded'] },
      reason: String,
      openedAt: Date,
      resolvedAt: Date,
      note: String,
    },
  },
  { timestamps: true }
);

// One shipment per seller per order, so a retried payment can never create a second one.
shipmentSchema.index({ order: 1, vendor: 1 }, { unique: true });

module.exports = mongoose.model('Shipment', shipmentSchema);
