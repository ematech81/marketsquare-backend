const router = require('express').Router();
const Category = require('../models/Category');
const Product = require('../models/Product');
const HttpError = require('../utils/httpError');
const { protect, requireRole } = require('../middleware/auth');
const { findOrCreateCategory } = require('../services/categories');
const { loadAll, withDescendants, pathOf } = require('../services/categoryTree');
const { categoryLimiter } = require('../middleware/rateLimit');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SORTS = {
  newest: { createdAt: -1 },
  price_asc: { price: 1 },
  price_desc: { price: -1 },
  rating: { ratingAverage: -1, ratingCount: -1 },
};

const publicProduct = (p) => ({
  id: p._id,
  title: p.title,
  slug: p.slug,
  description: p.description,
  category: p.category,
  price: p.price,
  compareAtPrice: p.compareAtPrice,
  images: p.images,
  variants: p.variants,
  inStock: p.stock > 0,
  stock: p.stock,
  ratingAverage: p.ratingAverage,
  ratingCount: p.ratingCount,
  brand: p.brand,
  sku: p.sku,
  gtin: p.gtin,
  tags: p.tags,
  highlights: p.highlights,
  details: p.details,
  seoTitle: p.seoTitle,
  seoDescription: p.seoDescription,
  updatedAt: p.updatedAt,
  seller: p.vendor ? { id: p.vendor._id, name: p.vendor.businessName } : { id: null, name: 'Square Market' },
});

// A vendor or admin who cannot find their category adds it. It joins the one shared list used everywhere.
router.post('/categories', protect, requireRole('vendor', 'admin'), categoryLimiter, async (req, res) => {
  const { category, created } = await findOrCreateCategory(req.body?.name, req.body?.parent);
  res.status(created ? 201 : 200).json({ category, created });
});

router.get('/categories', async (req, res) => {
  const categories = await Category.find().sort({ order: 1, name: 1 });
  res.json({ categories });
});

router.get('/products', async (req, res) => {
  const { q, category, minPrice, maxPrice, sort = 'newest', inStock, minRating, vendor } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(48, Math.max(1, parseInt(req.query.limit, 10) || 12));

  const filter = { status: 'active' };
  if (q) {
    const rx = { $regex: escapeRegex(String(q).trim()), $options: 'i' };
    filter.$and = [{ $or: [{ title: rx }, { brand: rx }, { tags: rx }] }];
  }
  if (category) {
    // Several categories can be chosen at once: category=fashion,beauty.
    const slugs = String(category).split(',').map((s) => s.trim()).filter(Boolean);
    const all = await loadAll();
    const picked = all.filter((c) => slugs.includes(c.slug));
    // Browsing a category includes everything inside it: "Fashion" shows Men's fashion and Men's shoes too.
    // An unknown category matches nothing rather than everything.
    filter.category = { $in: [...withDescendants(all, picked.map((c) => c._id))] };
  }
  if (vendor) {
    // vendor=<id,id> picks stores; vendor=house is the store's own products.
    const wanted = String(vendor).split(',').map((s) => s.trim()).filter(Boolean);
    const ids = wanted.filter((v) => /^[a-f0-9]{24}$/i.test(v));
    const or = [];
    if (ids.length) or.push({ vendor: { $in: ids } });
    if (wanted.includes('house')) or.push({ vendor: null });
    filter.$or = or.length ? or : [{ _id: null }];
  }
  if (inStock === '1') filter.stock = { $gt: 0 };
  if (minRating) filter.ratingAverage = { $gte: Number(minRating) };
  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }

  const [total, products] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter)
      .sort(SORTS[sort] || SORTS.newest)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('category', 'name slug')
      .populate('vendor', 'businessName'),
  ]);

  res.json({
    products: products.map(publicProduct),
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
  });
});

router.get('/products/:slug', async (req, res) => {
  const product = await Product.findOne({ $or: [{ slug: req.params.slug }, { oldSlugs: req.params.slug }], status: 'active' })
    .populate('category', 'name slug')
    .populate('vendor', 'businessName');
  if (!product) throw new HttpError(404, 'Product not found');
  // The full trail, for the breadcrumb: Fashion > Men's fashion > Men's shoes.
  const categoryPath = pathOf(await loadAll(), product.category._id);
  res.json({ product: { ...publicProduct(product), categoryPath } });
});

module.exports = router;
