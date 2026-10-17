const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';

const app = require('../src/app');
const User = require('../src/models/User');
const Vendor = require('../src/models/Vendor');

let mongod;
let server;
let base;
let admin;
let vendorToken;
const ids = {};

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};
const addCategory = (name, parent) => call('POST', '/admin/categories', { token: admin, body: { name, ...(parent ? { parent } : {}) } });
const addProduct = (title, category) =>
  call('POST', '/admin/products', {
    token: admin,
    body: { title, description: 'A good product to buy', category, price: 10000, stock: 5, images: [{ url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' }], status: 'active' },
  });
const slugsOf = async (query) => (await call('GET', `/products?${query}`)).data.products.map((p) => p.slug).sort();

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  admin = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  const owner = await User.create({ name: 'Zara', email: 'zara@example.com', phone: '08011110001', passwordHash: await bcrypt.hash('password123', 4), role: 'vendor' });
  await Vendor.create({
    user: owner._id, businessName: 'Zara Shop', category: 'Fashion', state: 'Lagos', city: 'Ikeja', phone: '08011110001',
    idType: 'nin', idNumber: '12345678901', bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Zara' }, status: 'approved',
  });
  vendorToken = (await call('POST', '/auth/login', { body: { email: 'zara@example.com', password: 'password123' } })).data.token;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('categories can go inside other categories, up to three levels', async () => {
  ids.fashion = (await addCategory('Fashion')).data.category._id;
  const mens = await addCategory("Men's fashion", ids.fashion);
  assert.equal(mens.status, 201);
  ids.mens = mens.data.category._id;
  assert.equal(mens.data.category.parent, ids.fashion);
  ids.womens = (await addCategory("Women's fashion", ids.fashion)).data.category._id;
  const shoes = await addCategory("Men's shoes", ids.mens);
  assert.equal(shoes.status, 201);
  ids.shoes = shoes.data.category._id;

  // A fourth level is too deep.
  const tooDeep = await addCategory('Sneakers', ids.shoes);
  assert.equal(tooDeep.status, 400);
  assert.match(tooDeep.data.message, /3 levels deep/);
  // A parent that does not exist.
  assert.equal((await addCategory('Ghost', '0123456789abcdef01234567')).status, 400);

  // The public list says where each one sits, and a plain category stays top level.
  const list = (await call('GET', '/categories')).data.categories;
  assert.equal(list.length, 4);
  assert.equal(list.find((c) => c.name === 'Fashion').parent, null);
  assert.equal(list.find((c) => c.name === "Men's shoes").parent, ids.mens);
});

test('a category cannot be moved inside itself or its own sub-categories', async () => {
  const put = (id, name, parent) => call('PUT', `/admin/categories/${id}`, { token: admin, body: { name, parent } });
  assert.equal((await put(ids.fashion, 'Fashion', ids.fashion)).status, 400);
  assert.equal((await put(ids.fashion, 'Fashion', ids.shoes)).status, 400); // inside its own child's child
  // Moving Men's fashion (which has Men's shoes inside it) under Women's fashion would make 4 levels: Fashion > Women's > Men's > Shoes.
  assert.equal((await put(ids.mens, "Men's fashion", ids.womens)).status, 400);
  // Renaming without sending a parent leaves it where it is.
  const renamed = await call('PUT', `/admin/categories/${ids.mens}`, { token: admin, body: { name: "Men's fashion" } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.category.parent, ids.fashion);
});

test('browsing a category also shows what is inside it', async () => {
  const polo = (await addProduct('Polo Shirt', ids.mens)).data.product;
  const loafers = (await addProduct('Leather Loafers', ids.shoes)).data.product;
  const dress = (await addProduct('Summer Dress', ids.womens)).data.product;
  const top = (await addProduct('Plain Fashion Item', ids.fashion)).data.product;

  assert.deepEqual(await slugsOf('category=mens-shoes'), [loafers.slug]);
  assert.deepEqual(await slugsOf("category=mens-fashion"), [loafers.slug, polo.slug].sort());
  assert.deepEqual(await slugsOf('category=fashion'), [dress.slug, loafers.slug, polo.slug, top.slug].sort());
  // Two at once, and an unknown one matches nothing.
  assert.deepEqual(await slugsOf('category=womens-fashion,mens-shoes'), [dress.slug, loafers.slug].sort());
  assert.deepEqual(await slugsOf('category=nothing-here'), []);
  ids.loafersSlug = loafers.slug;
});

test('a product page knows the whole trail for its breadcrumb', async () => {
  const product = (await call('GET', `/products/${ids.loafersSlug}`)).data.product;
  assert.deepEqual(product.categoryPath.map((c) => c.name), ['Fashion', "Men's fashion", "Men's shoes"]);
  assert.equal(product.category.name, "Men's shoes");
});

test('a category with sub-categories cannot be deleted until they are gone', async () => {
  const blocked = await call('DELETE', `/admin/categories/${ids.fashion}`, { token: admin });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.message, /sub-categories/);
  // One with products cannot be deleted either (as before).
  assert.equal((await call('DELETE', `/admin/categories/${ids.shoes}`, { token: admin })).status, 409);
});

test('a vendor who cannot find their category adds it inside another one', async () => {
  const made = await call('POST', '/categories', { token: vendorToken, body: { name: "Kids' shoes", parent: ids.fashion } });
  assert.equal(made.status, 201);
  assert.equal(made.data.category.parent, ids.fashion);
  // The same name again (any case) is the same category, wherever it was asked for.
  const again = await call('POST', '/categories', { token: vendorToken, body: { name: "kids' SHOES", parent: ids.mens } });
  assert.equal(again.status, 200);
  assert.equal(again.data.created, false);
  assert.equal(again.data.category._id, made.data.category._id);
  // A bad parent is refused.
  assert.equal((await call('POST', '/categories', { token: vendorToken, body: { name: 'Hats', parent: 'nope' } })).status, 400);
  // Without a parent it is top level, as before.
  assert.equal((await call('POST', '/categories', { token: vendorToken, body: { name: 'Toys' } })).data.category.parent, null);
});

test('moving a category to a new parent works, and to the top level too', async () => {
  const sunglasses = (await addCategory('Sunglasses', ids.womens)).data.category;
  const moved = await call('PUT', `/admin/categories/${sunglasses._id}`, { token: admin, body: { name: 'Sunglasses', parent: ids.mens } });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.category.parent, ids.mens);
  const top = await call('PUT', `/admin/categories/${sunglasses._id}`, { token: admin, body: { name: 'Sunglasses', parent: null } });
  assert.equal(top.data.category.parent, null);
});
