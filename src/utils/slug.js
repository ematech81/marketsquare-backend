const crypto = require('crypto');

const slugify = (text) =>
  String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Kept for older callers: a slug with a short random suffix.
const uniqueSlug = (text) => `${slugify(text) || 'item'}-${crypto.randomBytes(3).toString('hex')}`;

// A clean, readable web address for a product ("ankara-shirt"). If another product already uses it (as its
// address now or in the past), a number is added ("ankara-shirt-2"). `exceptId` is the product being edited.
async function freeSlug(Product, wanted, exceptId) {
  const base = slugify(wanted).slice(0, 80) || 'item';
  for (let n = 1; n < 500; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const taken = await Product.exists({
      $or: [{ slug: candidate }, { oldSlugs: candidate }],
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    });
    if (!taken) return candidate;
  }
  return uniqueSlug(base);
}

module.exports = { slugify, uniqueSlug, freeSlug };

// Moves a product to a new web address. The old address is remembered, so old links and Google results still
// work and send visitors to the new one.
async function changeSlug(Product, product, wanted) {
  if (!wanted || wanted === product.slug) return;
  const next = await freeSlug(Product, wanted, product._id);
  if (next === product.slug) return;
  if (!product.oldSlugs.includes(product.slug)) product.oldSlugs.push(product.slug);
  product.oldSlugs = product.oldSlugs.filter((s) => s !== next);
  product.slug = next;
}

module.exports.changeSlug = changeSlug;
