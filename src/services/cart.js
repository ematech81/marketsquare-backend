const Cart = require('../models/Cart');

const sameOptions = (a, b) =>
  a.length === b.length && a.every((x) => b.some((y) => y.name === x.name && y.value === x.value));

// Reads the cart with live prices and stock. Items whose product was removed or unpublished are dropped
// from the view, and items asking for more than is in stock are flagged so checkout can refuse them.
async function readCart(userId) {
  const cart = await Cart.findOne({ user: userId }).populate({
    path: 'items.product',
    populate: { path: 'vendor', select: 'businessName' },
  });

  const lines = [];
  for (const item of cart?.items ?? []) {
    const p = item.product;
    if (!p || p.status !== 'active') continue;
    lines.push({
      id: item._id,
      product: {
        id: p._id,
        title: p.title,
        slug: p.slug,
        image: p.images[0]?.url ?? null,
        seller: p.vendor ? { id: p.vendor._id, name: p.vendor.businessName } : { id: null, name: 'Square Market' },
      },
      vendor: p.vendor ? p.vendor._id : null,
      price: p.price,
      quantity: item.quantity,
      options: item.options,
      stock: p.stock,
      issue: p.stock < item.quantity ? (p.stock === 0 ? 'Out of stock' : `Only ${p.stock} left`) : null,
      lineTotal: p.price * item.quantity,
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  return { items: lines, subtotal, itemCount };
}

module.exports = { readCart, sameOptions };
