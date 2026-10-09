const crypto = require('crypto');

const slugify = (text) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Products share titles, so add a short random suffix to keep slugs unique.
const uniqueSlug = (text) => `${slugify(text) || 'item'}-${crypto.randomBytes(3).toString('hex')}`;

module.exports = { slugify, uniqueSlug };
