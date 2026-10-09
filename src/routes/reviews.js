const router = require('express').Router();
const { z } = require('zod');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Review = require('../models/Review');
const Shipment = require('../models/Shipment');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const HttpError = require('../utils/httpError');

const findProduct = async (slug) => {
  const product = await Product.findOne({ slug, status: 'active' });
  if (!product) throw new HttpError(404, 'Product not found');
  return product;
};

// Only someone whose order containing this product was delivered can review it.
async function eligibility(user, product) {
  if (await Review.exists({ product: product._id, user: user._id })) return { canReview: false, reason: 'You have already reviewed this product.' };
  const orderIds = (await Order.find({ user: user._id, paymentStatus: 'paid' }).select('_id')).map((o) => o._id);
  const bought = await Shipment.exists({ order: { $in: orderIds }, status: 'delivered', 'items.product': product._id });
  return bought ? { canReview: true } : { canReview: false, reason: 'Only customers who received this product can review it.' };
}

router.get('/products/:slug/reviews', async (req, res) => {
  const product = await findProduct(req.params.slug);
  const reviews = await Review.find({ product: product._id }).populate('user', 'name').sort({ createdAt: -1 }).limit(50);
  res.json({
    reviews: reviews.map((r) => {
      const [first = 'Customer', last = ''] = (r.user?.name ?? '').split(' ');
      return { id: r._id, rating: r.rating, body: r.body, author: last ? `${first} ${last.charAt(0)}.` : first, createdAt: r.createdAt };
    }),
    average: product.ratingAverage,
    count: product.ratingCount,
  });
});

router.get('/products/:slug/reviews/eligibility', protect, async (req, res) => {
  res.json(await eligibility(req.user, await findProduct(req.params.slug)));
});

const reviewSchema = z.object({
  rating: z.number().int().min(1, 'Choose a rating').max(5, 'Choose a rating'),
  body: z.string().trim().max(1000, 'Keep it under 1,000 characters').optional(),
});

router.post('/products/:slug/reviews', protect, validate(reviewSchema), async (req, res) => {
  const product = await findProduct(req.params.slug);
  const check = await eligibility(req.user, product);
  if (!check.canReview) throw new HttpError(403, check.reason);

  const review = await Review.create({ product: product._id, user: req.user._id, ...req.body });

  const [stats] = await Review.aggregate([
    { $match: { product: product._id } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  product.ratingAverage = Math.round(stats.average * 10) / 10;
  product.ratingCount = stats.count;
  await product.save();

  res.status(201).json({ review });
});

module.exports = router;
