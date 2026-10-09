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
  },
  { timestamps: true }
);

// One shipment per seller per order, so a retried payment can never create a second one.
shipmentSchema.index({ order: 1, vendor: 1 }, { unique: true });

module.exports = mongoose.model('Shipment', shipmentSchema);
