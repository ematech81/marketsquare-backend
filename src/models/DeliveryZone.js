const mongoose = require('mongoose');

// One row per state we deliver to. A state with no row is not delivered to.
const deliveryZoneSchema = new mongoose.Schema(
  {
    state: { type: String, required: true, unique: true, trim: true },
    fee: { type: Number, required: true, min: 0 },
    estimatedDays: { type: Number, min: 1, default: 3 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DeliveryZone', deliveryZoneSchema);
