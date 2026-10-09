const router = require('express').Router();
const { z } = require('zod');
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { readCart, sameOptions } = require('../services/cart');
const HttpError = require('../utils/httpError');

router.use(protect);

router.get('/', async (req, res) => {
  res.json(await readCart(req.user._id));
});

const addSchema = z.object({
  productId: z.string().regex(/^[a-f\d]{24}$/i, 'Choose a product'),
  quantity: z.number().int().min(1).max(20).default(1),
  options: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
});

router.post('/items', validate(addSchema), async (req, res) => {
  const { productId, quantity, options } = req.body;
  const product = await Product.findOne({ _id: productId, status: 'active' });
  if (!product) throw new HttpError(404, 'This product is no longer available');

  // The buyer must pick one valid value for every option the product has.
  for (const variant of product.variants) {
    const chosen = options.find((o) => o.name === variant.name);
    if (!chosen || !variant.options.includes(chosen.value)) throw new HttpError(400, `Choose a ${variant.name}`);
  }
  const cleanOptions = product.variants.map((v) => ({ name: v.name, value: options.find((o) => o.name === v.name).value }));

  const cart = (await Cart.findOne({ user: req.user._id })) ?? new Cart({ user: req.user._id, items: [] });
  const existing = cart.items.find((i) => String(i.product) === productId && sameOptions(i.options, cleanOptions));
  const nextQty = (existing?.quantity ?? 0) + quantity;
  if (nextQty > product.stock) {
    throw new HttpError(409, product.stock === 0 ? 'This product is out of stock' : `Only ${product.stock} left in stock`);
  }

  if (existing) existing.quantity = nextQty;
  else cart.items.push({ product: productId, quantity, options: cleanOptions });
  await cart.save();

  res.status(201).json(await readCart(req.user._id));
});

router.patch('/items/:itemId', validate(z.object({ quantity: z.number().int().min(1).max(20) })), async (req, res) => {
  const cart = await Cart.findOne({ user: req.user._id });
  const item = cart?.items.id(req.params.itemId);
  if (!item) throw new HttpError(404, 'That item is not in your cart');

  const product = await Product.findById(item.product);
  if (!product || product.status !== 'active') throw new HttpError(404, 'This product is no longer available');
  if (req.body.quantity > product.stock) throw new HttpError(409, `Only ${product.stock} left in stock`);

  item.quantity = req.body.quantity;
  await cart.save();
  res.json(await readCart(req.user._id));
});

router.delete('/items/:itemId', async (req, res) => {
  await Cart.updateOne({ user: req.user._id }, { $pull: { items: { _id: req.params.itemId } } });
  res.json(await readCart(req.user._id));
});

module.exports = router;
