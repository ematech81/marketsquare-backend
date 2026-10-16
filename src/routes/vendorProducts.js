const router = require('express').Router();
const Category = require('../models/Category');
const Product = require('../models/Product');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { requireVendor } = require('../middleware/vendor');
const HttpError = require('../utils/httpError');
const { freeSlug, changeSlug } = require('../utils/slug');
const { productSchema } = require('../utils/productSchema');
const { signUpload } = require('../utils/cloudinary');
const { getStoreSettings } = require('../services/storeSettings');
const { notifyAdmins } = require('../services/notifications');

router.use(protect, requireVendor);

async function ownProduct(req) {
  const product = await Product.findOne({ _id: req.params.id, vendor: req.vendor._id });
  if (!product) throw new HttpError(404, 'Product not found');
  return product;
}

async function assertCategory(id) {
  if (!(await Category.exists({ _id: id }))) throw new HttpError(400, 'category: Choose a category');
}

router.get('/products', async (req, res) => {
  const products = await Product.find({ vendor: req.vendor._id }).sort({ createdAt: -1 }).populate('category', 'name slug');
  res.json({ products });
});

router.get('/products/:id', async (req, res) => {
  res.json({ product: await ownProduct(req) });
});

// A vendor can save a draft, or publish. Publishing goes to the admin for review first when the store requires it.
router.post('/products', validate(productSchema), async (req, res) => {
  await assertCategory(req.body.category);
  const { requireListingApproval } = await getStoreSettings();
  const status = req.body.status === 'active' ? (requireListingApproval ? 'pending' : 'active') : 'draft';
  const slug = await freeSlug(Product, req.body.slug || req.body.title);
  const product = await Product.create({ ...req.body, status, slug, vendor: req.vendor._id });
  if (status === 'pending') {
    notifyAdmins({ type: 'admin_product_review', title: 'Product waiting for review', body: `${req.vendor.businessName}: ${product.title}`, link: '/products' });
  }
  res.status(201).json({ product });
});

const urlsOf = (images) => images.map((i) => i.url).join('|');

router.put('/products/:id', validate(productSchema), async (req, res) => {
  await assertCategory(req.body.category);
  const product = await ownProduct(req);
  const { requireListingApproval } = await getStoreSettings();

  // Changing what a customer reads or sees on a live product sends it back for review. Price and stock never do.
  const contentChanged =
    product.title !== req.body.title ||
    product.description !== req.body.description ||
    String(product.category) !== req.body.category ||
    urlsOf(product.images) !== urlsOf(req.body.images);

  let status;
  if (req.body.status === 'draft') status = 'draft';
  else if (product.status === 'active' && !(contentChanged && requireListingApproval)) status = 'active';
  else status = requireListingApproval ? 'pending' : 'active';

  const { slug: wantedSlug, ...fields } = req.body;
  product.set({ ...fields, status, rejectionReason: undefined });
  await changeSlug(Product, product, wantedSlug);
  await product.save();
  if (status === 'pending') {
    notifyAdmins({ type: 'admin_product_review', title: 'Product waiting for review', body: `${req.vendor.businessName}: ${product.title}`, link: '/products' });
  }
  res.json({ product });
});

router.delete('/products/:id', async (req, res) => {
  const product = await ownProduct(req);
  await product.deleteOne();
  res.json({ ok: true });
});

router.post('/uploads/sign', (req, res) => {
  res.json(signUpload(`squaremarket/vendors/${req.vendor._id}`, req.body?.name));
});

module.exports = router;
