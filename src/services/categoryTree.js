const Category = require('../models/Category');
const HttpError = require('../utils/httpError');

// Categories form a tree: Fashion > Men's fashion > Men's shoes. Three levels is enough for a shop, and keeps menus short.
const MAX_LEVELS = 3;

const idOf = (v) => (v ? String(v._id ?? v) : null);

async function loadAll() {
  return Category.find().sort({ order: 1, name: 1 });
}

// The category with this id, and everything inside it, as a set of id strings.
// Browsing "Fashion" shows the products of Men's fashion and Men's shoes too.
function withDescendants(all, rootIds) {
  const kids = new Map();
  for (const c of all) {
    const p = idOf(c.parent);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(idOf(c));
  }
  const out = new Set();
  const stack = rootIds.map(idOf);
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const k of kids.get(id) ?? []) stack.push(k);
  }
  return out;
}

// How many levels above this category: 0 for a top-level category.
function depthOf(all, id) {
  const byId = new Map(all.map((c) => [idOf(c), c]));
  let depth = 0;
  let cur = byId.get(idOf(id));
  const seen = new Set();
  while (cur && idOf(cur.parent) && !seen.has(idOf(cur))) {
    seen.add(idOf(cur));
    depth += 1;
    cur = byId.get(idOf(cur.parent));
  }
  return depth;
}

// How many levels this category's own sub-categories add below it (0 when it has none).
function heightOf(all, id) {
  const kids = all.filter((c) => idOf(c.parent) === idOf(id));
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => heightOf(all, idOf(k))));
}

// The names from the top down, for a breadcrumb: [Fashion, Men's fashion, Men's shoes].
function pathOf(all, id) {
  const byId = new Map(all.map((c) => [idOf(c), c]));
  const path = [];
  let cur = byId.get(idOf(id));
  const seen = new Set();
  while (cur && !seen.has(idOf(cur))) {
    seen.add(idOf(cur));
    path.unshift({ name: cur.name, slug: cur.slug });
    cur = byId.get(idOf(cur.parent));
  }
  return path;
}

// Checks that `parentId` is a fine place for a category: it exists, is not the category itself or inside it, and does
// not make the tree deeper than MAX_LEVELS. `categoryId` is null when the category is being created.
async function assertValidParent(parentId, categoryId = null) {
  if (!parentId) return null;
  const all = await loadAll();
  const parent = all.find((c) => idOf(c) === String(parentId));
  if (!parent) throw new HttpError(400, 'parent: That parent category does not exist');
  if (categoryId) {
    if (String(parentId) === String(categoryId) || withDescendants(all, [categoryId]).has(String(parentId))) {
      throw new HttpError(400, 'parent: A category cannot go inside itself');
    }
  }
  const below = categoryId ? heightOf(all, categoryId) : 0;
  if (depthOf(all, parentId) + 1 + below > MAX_LEVELS - 1) {
    throw new HttpError(400, `parent: Categories can only go ${MAX_LEVELS} levels deep, like Fashion > Men's fashion > Men's shoes`);
  }
  return parent;
}

module.exports = { MAX_LEVELS, loadAll, withDescendants, depthOf, heightOf, pathOf, assertValidParent };
