const router = require('express').Router();
const crypto = require('crypto');
const { z } = require('zod');
const Category = require('../models/Category');
const Product = require('../models/Product');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const HttpError = require('../utils/httpError');
const { slugify, uniqueSlug } = require('../utils/slug');

router.use(protect, requireRole('admin'));

// ---------- Categories ----------

const categorySchema = z.object({
  name: z.string().trim().min(2, 'Enter a category name'),
  image: z.string().trim().url().optional(),
  order: z.number().int().optional(),
});

router.post('/categories', validate(categorySchema), async (req, res) => {
  const slug = slugify(req.body.name);
  if (await Category.exists({ $or: [{ slug }, { name: req.body.name }] })) {
    throw new HttpError(409, 'A category with this name already exists');
  }
  const category = await Category.create({ ...req.body, slug });
  res.status(201).json({ category });
});

router.put('/categories/:id', validate(categorySchema), async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) throw new HttpError(404, 'Category not found');
  category.set({ ...req.body, slug: slugify(req.body.name) });
  await category.save();
  res.json({ category });
});

router.delete('/categories/:id', async (req, res) => {
  if (await Product.exists({ category: req.params.id })) {
    throw new HttpError(409, 'Move or delete the products in this category first');
  }
  await Category.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// ---------- Products ----------

const productSchema = z
  .object({
    title: z.string().trim().min(3, 'Enter a product title'),
    description: z.string().trim().min(10, 'Describe the product in a few words'),
    category: z.string().regex(/^[a-f\d]{24}$/i, 'Choose a category'),
    price: z.number().int('Price must be a whole number of Naira').positive('Enter a price'),
    compareAtPrice: z.number().int().positive().optional(),
    images: z
      .array(z.object({ url: z.string().url(), publicId: z.string().optional() }))
      .max(8, 'Up to 8 images')
      .default([]),
    variants: z
      .array(z.object({ name: z.string().trim().min(1), options: z.array(z.string().trim().min(1)).min(1) }))
      .default([]),
    stock: z.number().int().min(0, 'Stock cannot be negative'),
    status: z.enum(['draft', 'active']).default('active'),
  })
  .refine((p) => p.compareAtPrice === undefined || p.compareAtPrice > p.price, {
    path: ['compareAtPrice'],
    message: 'Must be higher than the price',
  })
  .refine((p) => p.status !== 'active' || p.images.length > 0, {
    path: ['images'],
    message: 'Add at least one image before publishing',
  });

async function assertCategory(id) {
  if (!(await Category.exists({ _id: id }))) throw new HttpError(400, 'category: Choose a category');
}

router.get('/products', async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  const products = await Product.find(filter).sort({ createdAt: -1 }).populate('category', 'name slug');
  res.json({ products });
});

router.get('/products/:id', async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new HttpError(404, 'Product not found');
  res.json({ product });
});

router.post('/products', validate(productSchema), async (req, res) => {
  await assertCategory(req.body.category);
  const product = await Product.create({ ...req.body, slug: uniqueSlug(req.body.title), vendor: null });
  res.status(201).json({ product });
});

router.put('/products/:id', validate(productSchema), async (req, res) => {
  await assertCategory(req.body.category);
  const product = await Product.findById(req.params.id);
  if (!product) throw new HttpError(404, 'Product not found');
  // The slug stays the same so existing links keep working.
  product.set(req.body);
  await product.save();
  res.json({ product });
});

router.delete('/products/:id', async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) throw new HttpError(404, 'Product not found');
  res.json({ ok: true });
});

// ---------- Image uploads ----------

// The browser uploads straight to Cloudinary with this signature, so image bytes never pass through the API.
router.post('/uploads/sign', (req, res) => {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = process.env;
  if (!cloudName || !apiKey || !secret) {
    throw new HttpError(503, 'Image uploads are not set up yet. Add the Cloudinary keys to api/.env');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'squaremarket/products';
  const signature = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${secret}`).digest('hex');
  res.json({ cloudName, apiKey, timestamp, folder, signature });
});

module.exports = router;
