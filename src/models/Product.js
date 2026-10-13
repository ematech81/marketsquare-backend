const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    // null means the product is sold by Square Market itself (listed by the admin).
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    // Earlier web addresses of this product. They still work and send visitors to the current one.
    oldSlugs: { type: [String], default: [], index: true },
    // Written in Markdown: headings, bold, lists and links.
    description: { type: String, required: true, trim: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    // Prices are whole Naira.
    price: { type: Number, required: true, min: 1 },
    compareAtPrice: { type: Number, min: 1 },
    // alt is the text Google (and screen readers) use to understand a photo.
    images: [{ url: { type: String, required: true }, publicId: String, alt: { type: String, trim: true, maxlength: 125 }, _id: false }],
    // Choices the buyer picks from, e.g. { name: 'Size', options: ['S', 'M', 'L'] }.
    variants: [{ name: { type: String, required: true }, options: [String], _id: false }],
    stock: { type: Number, required: true, min: 0, default: 0 },
    brand: { type: String, trim: true },
    sku: { type: String, trim: true },
    // Barcode (EAN/UPC). Google uses it to recognise the exact product.
    gtin: { type: String, trim: true },
    tags: { type: [String], default: [] },
    // Facts shown in a table on the product page, e.g. { label: 'Weight', value: '340 g' }.
    details: [{ label: { type: String, required: true, trim: true }, value: { type: String, required: true, trim: true }, _id: false }],
    // What Google shows in search results. Empty means we build them from the title and description.
    seoTitle: { type: String, trim: true },
    seoDescription: { type: String, trim: true },
    status: { type: String, enum: ['draft', 'pending', 'active', 'rejected'], default: 'draft', index: true },
    // Why the admin turned down a vendor's listing.
    rejectionReason: { type: String, trim: true },
    ratingAverage: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Product', productSchema);
