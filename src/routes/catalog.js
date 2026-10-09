const router = require('express').Router();
const Category = require('../models/Category');
const Product = require('../models/Product');
const HttpError = require('../utils/httpError');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SORTS = {
  newest: { createdAt: -1 },
  price_asc: { price: 1 },
  price_desc: { price: -1 },
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
  seller: p.vendor ? { id: p.vendor._id, name: p.vendor.businessName } : { id: null, name: 'Square Market' },
});

router.get('/categories', async (req, res) => {
  const categories = await Category.find().sort({ order: 1, name: 1 });
  res.json({ categories });
});

router.get('/products', async (req, res) => {
  const { q, category, minPrice, maxPrice, sort = 'newest' } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(48, Math.max(1, parseInt(req.query.limit, 10) || 12));

  const filter = { status: 'active' };
  if (q) filter.title = { $regex: escapeRegex(String(q).trim()), $options: 'i' };
  if (category) {
    const cat = await Category.findOne({ slug: String(category) });
    // An unknown category matches nothing rather than everything.
    filter.category = cat ? cat._id : null;
  }
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
  const product = await Product.findOne({ slug: req.params.slug, status: 'active' })
    .populate('category', 'name slug')
    .populate('vendor', 'businessName');
  if (!product) throw new HttpError(404, 'Product not found');
  res.json({ product: publicProduct(product) });
});

module.exports = router;
