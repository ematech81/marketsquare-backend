const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
process.env.KORAPAY_SECRET_KEY = 'sk_test_unit';
process.env.KORAPAY_PREFIX = 'SQM';

const app = require('../src/app');
const korapay = require('../src/services/korapay');
const mailer = require('../src/services/mailer');
const User = require('../src/models/User');
const Vendor = require('../src/models/Vendor');
const Product = require('../src/models/Product');
const Category = require('../src/models/Category');
const Order = require('../src/models/Order');
const Shipment = require('../src/models/Shipment');
const Cart = require('../src/models/Cart');

let mongod;
let server;
let base;
let admin;
let ada;
let zara; // a vendor's login
let zaraVendor;
let category;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

const productBody = (title, extra = {}) => ({
  title,
  description: 'A good product to buy',
  category: String(category._id),
  price: 40000,
  stock: 10,
  images: [{ url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' }],
  status: 'active',
  ...extra,
});
const publish = (title, extra) => call('POST', '/vendor/products', { token: zara, body: productBody(title, extra) });
const setMode = (body) =>
  call('PUT', '/admin/settings', { token: admin, body: { defaultCommissionRate: 10, minPayoutAmount: 10000, payoutHoldDays: 0, newVendorExtraHoldDays: 0, ...body } });
const approve = (id) => call('PATCH', `/admin/products/${id}/review`, { token: admin, body: { decision: 'approve' } });

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  korapay.initializeCharge = async (a) => ({ checkout_url: `https://checkout.korapay.com/${a.reference}/pay` });
  mailer.setTransport({ sendMail: async () => undefined });

  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  admin = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  ada = (await call('POST', '/auth/register', { body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' } })).data.token;
  await call('PUT', '/admin/delivery-zones', { token: admin, body: { zones: [{ state: 'Lagos', fee: 2000, estimatedDays: 2 }] } });

  category = await Category.create({ name: 'Drinks', slug: 'drinks' });
  const owner = await User.create({ name: 'Zara', email: 'zara@example.com', phone: '08011110001', passwordHash: await bcrypt.hash('password123', 4), role: 'vendor' });
  zaraVendor = await Vendor.create({
    user: owner._id, businessName: 'Zara Drinks', category: 'Drinks', state: 'Lagos', city: 'Ikeja', phone: '08011110001',
    idType: 'nin', idNumber: '12345678901', bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Zara' }, status: 'approved',
  });
  zara = (await call('POST', '/auth/login', { body: { email: 'zara@example.com', password: 'password123' } })).data.token;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('an 18+ product is saved with its mark, shown publicly, and always checked by the admin', async () => {
  await setMode({ listingReviewMode: 'none' }); // even when nothing else is checked
  const wine = await publish('Red Wine 75cl', { ageRestricted: true });
  assert.equal(wine.status, 201);
  assert.equal(wine.data.product.status, 'pending');
  assert.equal(wine.data.product.ageRestricted, true);

  // Not public until approved; then it carries the 18+ mark.
  assert.equal((await call('GET', `/products/${wine.data.product.slug}`)).status, 404);
  assert.equal((await approve(wine.data.product._id)).status, 200);
  const shown = (await call('GET', `/products/${wine.data.product.slug}`)).data.product;
  assert.equal(shown.ageRestricted, true);
  assert.equal((await call('GET', '/products')).data.products.find((p) => p.slug === shown.slug).ageRestricted, true);

  // An ordinary product is not marked, and goes live at once while nothing else is checked.
  const juice = await publish('Orange Juice');
  assert.equal(juice.data.product.status, 'active');
  assert.equal((await call('GET', `/products/${juice.data.product.slug}`)).data.product.ageRestricted, false);
});

test('a vendor cannot quietly remove the 18+ mark from a live product', async () => {
  const wine = await Product.findOne({ title: 'Red Wine 75cl' });
  assert.equal(wine.status, 'active');
  const edit = (extra) => call('PUT', `/vendor/products/${wine._id}`, { token: zara, body: productBody('Red Wine 75cl', { slug: wine.slug, ...extra }) });

  // A price change on its own stays live.
  assert.equal((await edit({ ageRestricted: true, price: 45000 })).data.product.status, 'active');
  // Turning the mark off sends it back for review.
  const off = await edit({ ageRestricted: false });
  assert.equal(off.status, 200);
  assert.equal(off.data.product.status, 'pending');
});

test('buyers must confirm they are 18 or older, and the order remembers which items are 18+', async () => {
  const beer = await Product.create({
    title: 'Lager Beer', slug: 'lager-beer', description: 'A cold beer to drink', category: category._id, price: 40000, stock: 10,
    status: 'active', ageRestricted: true, images: [{ url: 'https://res.cloudinary.com/demo/image/upload/b.jpg' }],
  });
  await Cart.deleteMany({});
  await call('POST', '/cart/items', { token: ada, body: { productId: beer._id, quantity: 1 } });
  const cart = (await call('GET', '/cart', { token: ada })).data;
  assert.equal(cart.items[0].product.ageRestricted, true); // the checkout page needs this

  const address = { fullName: 'Ada Obi', phone: '+2348031234567', street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' };
  const without = await call('POST', '/orders/checkout', { token: ada, body: { address } });
  assert.equal(without.status, 400);
  assert.match(without.data.message, /18/);
  assert.equal((await call('POST', '/orders/checkout', { token: ada, body: { address, ageConfirmed: false } })).status, 400);

  const ok = await call('POST', '/orders/checkout', { token: ada, body: { address, ageConfirmed: true } });
  assert.equal(ok.status, 201);
  const order = await Order.findOne({ orderNumber: ok.data.orderNumber });
  assert.equal(order.ageConfirmed, true);
  assert.equal(order.items[0].ageRestricted, true);
});

test('an order with no 18+ items does not ask for age confirmation', async () => {
  const cola = await Product.create({
    title: 'Cola', slug: 'cola', description: 'A cold soft drink', category: category._id, price: 40000, stock: 10,
    status: 'active', images: [{ url: 'https://res.cloudinary.com/demo/image/upload/c.jpg' }],
  });
  await Cart.deleteMany({});
  await call('POST', '/cart/items', { token: ada, body: { productId: cola._id, quantity: 1 } });
  const address = { fullName: 'Ada Obi', phone: '+2348031234567', street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' };
  const res = await call('POST', '/orders/checkout', { token: ada, body: { address } });
  assert.equal(res.status, 201);
  assert.equal((await Order.findOne({ orderNumber: res.data.orderNumber })).ageConfirmed, undefined);
});

test('the delivery person is told which items are 18+ (the shipment carries the mark)', async () => {
  const beer = await Product.findOne({ slug: 'lager-beer' });
  await Cart.deleteMany({});
  await call('POST', '/cart/items', { token: ada, body: { productId: beer._id, quantity: 1 } });
  const address = { fullName: 'Ada Obi', phone: '+2348031234567', street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' };
  const placed = await call('POST', '/orders/checkout', { token: ada, body: { address, paymentMethod: 'cod', ageConfirmed: true } });
  assert.equal(placed.status, 201);
  const shipment = await Shipment.findOne({ order: (await Order.findOne({ orderNumber: placed.data.orderNumber }))._id });
  assert.equal(shipment.items[0].ageRestricted, true);
  const adminView = (await call('GET', `/admin/orders/${placed.data.orderNumber}`, { token: admin })).data.order;
  assert.equal(adminView.shipments[0].items[0].ageRestricted, true);
});

test('review mode "all": every new listing is checked; "none": no ordinary listing is', async () => {
  await setMode({ listingReviewMode: 'all' });
  assert.equal((await publish('Palm Wine')).data.product.status, 'pending');
  assert.equal((await call('GET', '/vendor/listing-review', { token: zara })).data.reviewsNew, true);

  const off = await setMode({ listingReviewMode: 'none' });
  assert.equal(off.data.settings.requireListingApproval, false); // the old switch follows the mode
  assert.equal((await publish('Coconut Water')).data.product.status, 'active');
  assert.equal((await call('GET', '/vendor/listing-review', { token: zara })).data.reviewsNew, false);
});

test('the old on/off switch still works', async () => {
  const on = await call('PUT', '/admin/settings', { token: admin, body: { defaultCommissionRate: 10, minPayoutAmount: 10000, requireListingApproval: true } });
  assert.equal(on.data.settings.listingReviewMode, 'all');
  const off = await call('PUT', '/admin/settings', { token: admin, body: { defaultCommissionRate: 10, minPayoutAmount: 10000, requireListingApproval: false } });
  assert.equal(off.data.settings.listingReviewMode, 'none');
});

test('smart mode: a new vendor is checked until the admin has approved enough of their listings, then they publish directly', async () => {
  await Product.deleteMany({ vendor: zaraVendor._id });
  await setMode({ listingReviewMode: 'smart', provenAfterApprovals: 2 });
  const status0 = (await call('GET', '/vendor/listing-review', { token: zara })).data;
  assert.deepEqual([status0.mode, status0.approved, status0.provenAfter, status0.reviewsNew], ['smart', 0, 2, true]);

  const a = await publish('Ginger Drink');
  assert.equal(a.data.product.status, 'pending');
  await approve(a.data.product._id);
  const b = await publish('Hibiscus Drink');
  assert.equal(b.data.product.status, 'pending'); // one approval is not enough yet
  await approve(b.data.product._id);

  // Two approved: proven. New listings go live straight away, and so do edits to live ones.
  const status2 = (await call('GET', '/vendor/listing-review', { token: zara })).data;
  assert.deepEqual([status2.approved, status2.reviewsNew], [2, false]);
  const c = await publish('Tiger Nut Drink');
  assert.equal(c.data.product.status, 'active');
  const edited = await call('PUT', `/vendor/products/${c.data.product._id}`, { token: zara, body: productBody('Tiger Nut Drink, Large', { slug: c.data.product.slug }) });
  assert.equal(edited.data.product.status, 'active');
  // An 18+ product is still checked, even for a proven vendor.
  assert.equal((await publish('Whisky', { ageRestricted: true })).data.product.status, 'pending');
});

test('the admin can override this for one vendor: always check, or trust', async () => {
  const set = (mode) => call('PATCH', `/admin/vendors/${zaraVendor._id}/listing-review`, { token: admin, body: { mode } });
  assert.equal((await call('PATCH', `/admin/vendors/${zaraVendor._id}/listing-review`, { token: zara, body: { mode: 'always' } })).status, 403);
  assert.equal((await set('sometimes')).status, 400);

  // Proven in smart mode, but marked "always": checked.
  assert.equal((await set('always')).data.vendor.listingReview, 'always');
  assert.equal((await publish('Zobo')).data.product.status, 'pending');

  // Not proven (mode "all") but marked "trusted": goes live.
  await setMode({ listingReviewMode: 'all' });
  assert.equal((await set('trusted')).data.vendor.listingReview, 'trusted');
  assert.equal((await publish('Kunu')).data.product.status, 'active');
  // Trusted does not skip the 18+ check.
  assert.equal((await publish('Gin', { ageRestricted: true })).data.product.status, 'pending');
  assert.equal((await set('auto')).data.vendor.listingReview, 'auto');
});

test('the admin can only choose a real mode, and the threshold must make sense', async () => {
  assert.equal((await setMode({ listingReviewMode: 'maybe' })).status, 400);
  assert.equal((await setMode({ listingReviewMode: 'smart', provenAfterApprovals: 0 })).status, 400);
  assert.equal((await setMode({ listingReviewMode: 'smart', provenAfterApprovals: 3 })).status, 200);
});
