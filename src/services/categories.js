const { z } = require('zod');
const Category = require('../models/Category');
const HttpError = require('../utils/httpError');
const { slugify } = require('../utils/slug');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Letters, numbers, spaces and a few marks, so a category name cannot hold markup or be a wall of symbols.
const nameSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(2, 'Enter a category name')
      .max(40, 'A category name can be at most 40 characters')
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} &,'/().+-]*$/u, 'Use letters and numbers only'),
  );

// Returns the category with this name, making it when it does not exist yet.
// "fashion", "Fashion" and " FASHION " are the same category, so the list never gets near-duplicates.
async function findOrCreateCategory(rawName) {
  const parsed = nameSchema.safeParse(rawName);
  if (!parsed.success) throw new HttpError(400, `category: ${parsed.error.issues[0].message}`);
  const name = parsed.data;
  const slug = slugify(name);
  if (!slug) throw new HttpError(400, 'category: Use letters and numbers only');

  const find = () => Category.findOne({ $or: [{ name: new RegExp(`^${escapeRegex(name)}$`, 'i') }, { slug }] });
  const existing = await find();
  if (existing) return { category: existing, created: false };
  try {
    return { category: await Category.create({ name, slug }), created: true };
  } catch (err) {
    // Two people adding the same new category at once: the second one gets the first one's.
    if (err.code === 11000) {
      const winner = await find();
      if (winner) return { category: winner, created: false };
    }
    throw err;
  }
}

module.exports = { findOrCreateCategory };
