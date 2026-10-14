const mongoose = require('mongoose');

// One slide in the home page's auto-scrolling banner. The admin uploads a finished design (for example from Canva).
const imageSchema = new mongoose.Schema({ url: { type: String, required: true }, publicId: String }, { _id: false });

const bannerSchema = new mongoose.Schema(
  {
    // A name for the admin's own list, e.g. "October promo". Never shown to customers.
    title: { type: String, required: true, trim: true, maxlength: 80 },
    image: { type: imageSchema, required: true },
    // Optional taller design for phones. Without it, phones show the wide image.
    mobileImage: { type: imageSchema },
    // A description of the picture, for people who cannot see it and for search engines.
    alt: { type: String, required: true, trim: true, maxlength: 125 },
    // Where a click goes: a page on this site ("/products?category=fashion") or a full https:// address. Empty means no link.
    link: { type: String, trim: true, maxlength: 500 },
    active: { type: Boolean, default: true },
    // Lower numbers show first.
    order: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Banner', bannerSchema);
