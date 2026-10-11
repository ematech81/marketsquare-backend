const router = require('express').Router();
const { z } = require('zod');
const Category = require('../models/Category');
const Product = require('../models/Product');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const HttpError = require('../utils/httpError');
const { slugify, uniqueSlug } = require('../utils/slug');
const { productSchema } = require('../utils/productSchema');
const { signUpload } = require('../utils/cloudinary');

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

async function assertCategory(id) {
  if (!(await Category.exists({ _id: id }))) throw new HttpError(400, 'category: Choose a category');
}

router.get('/products', async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  const products = await Product.find(filter).sort({ createdAt: -1 }).populate('category', 'name slug').populate('vendor', 'businessName');
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

router.post('/uploads/sign', (req, res) => {
  res.json(signUpload('squaremarket/products'));
});

module.exports = router;
