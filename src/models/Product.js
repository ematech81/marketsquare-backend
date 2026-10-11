const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    // null means the product is sold by Square Market itself (listed by the admin).
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, required: true, trim: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    // Prices are whole Naira.
    price: { type: Number, required: true, min: 1 },
    compareAtPrice: { type: Number, min: 1 },
    images: [{ url: { type: String, required: true }, publicId: String, _id: false }],
    // Choices the buyer picks from, e.g. { name: 'Size', options: ['S', 'M', 'L'] }.
    variants: [{ name: { type: String, required: true }, options: [String], _id: false }],
    stock: { type: Number, required: true, min: 0, default: 0 },
    status: { type: String, enum: ['draft', 'pending', 'active', 'rejected'], default: 'draft', index: true },
    // Why the admin turned down a vendor's listing.
    rejectionReason: { type: String, trim: true },
    ratingAverage: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Product', productSchema);
