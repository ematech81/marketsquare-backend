const mongoose = require('mongoose');

// One in-app notification for one person. The bell icon in the store and in the dashboard reads these.
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // A short machine label (order_placed, shipment_shipped, ...), so the app can pick an icon later.
    type: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, trim: true, maxlength: 300 },
    // A page inside the app that reads it, like /orders/SM-12345678.
    link: { type: String, trim: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, read: 1 });
// Old notifications clear themselves after 90 days, so the collection never grows without end.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('Notification', notificationSchema);
