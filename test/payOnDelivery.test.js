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
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const Vendor = require('../src/models/Vendor');
const Shipment = require('../src/models/Shipment');
const Category = require('../src/models/Category');
const Cart = require('../src/models/Cart');

let mongod;
let server;
let base;
let admin;
let ada;
let vendorId;
let house; // the store's own product
let vend; // a vendor's product
let charges = 0;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};
const address = { fullName: 'Ada Obi', phone: '+2348031234567', street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' };

const addToCart = (productId, quantity = 1) => call('POST', '/cart/items', { token: ada, body: { productId, quantity } });
const checkout = (extra = {}) => call('POST', '/orders/checkout', { token: ada, body: { address, ...extra } });
const setCod = (values) =>
  call('PUT', '/admin/settings', { token: admin, body: { defaultCommissionRate: 10, minPayoutAmount: 10000, requireListingApproval: false, ...values } });

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  korapay.initializeCharge = async (a) => {
    charges += 1;
    return { checkout_url: `https://checkout.korapay.com/${a.reference}/pay` };
  };
  mailer.setTransport({ sendMail: async () => undefined });

  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  admin = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  ada = (await call('POST', '/auth/register', { body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' } })).data.token;
  await call('PUT', '/admin/delivery-zones', { token: admin, body: { zones: [{ state: 'Lagos', fee: 2000, estimatedDays: 2 }] } });

  const cat = await Category.create({ name: 'Gadget', slug: 'gadget' });
  const owner = await User.create({ name: 'Zara', email: 'zara@example.com', phone: '08011110001', passwordHash: 'x', role: 'vendor' });
  const vendor = await Vendor.create({
    user: owner._id,
    businessName: 'Zara Tech',
    category: 'Gadget',
    state: 'Lagos',
    city: 'Ikeja',
    phone: '08011110001',
    idType: 'nin',
    idNumber: '12345678901',
    bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Zara' },
    status: 'approved',
  });
  vendorId = vendor._id;
  const common = { description: 'A good product to buy', category: cat._id, images: [{ url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' }], status: 'active' };
  house = await Product.create({ ...common, title: 'House Phone', slug: 'house-phone', price: 40000, stock: 20 });
  vend = await Product.create({ ...common, title: 'Vendor Laptop', slug: 'vendor-laptop', price: 50000, stock: 20, vendor: vendorId });
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('pay on delivery places the order at once: no KoraPay page, stock reserved, shipment made, cart emptied', async () => {
  await addToCart(house._id, 2); // 80,000 + 2,000 delivery
  const res = await checkout({ paymentMethod: 'cod' });
  assert.equal(res.status, 201);
  assert.equal(res.data.paymentMethod, 'cod');
  assert.equal(res.data.checkoutUrl, undefined);
  assert.equal(charges, 0);

  const order = await Order.findOne({ orderNumber: res.data.orderNumber });
  assert.equal(order.paymentMethod, 'cod');
  assert.equal(order.paymentStatus, 'cod');
  assert.equal(order.total, 82000);
  assert.match(order.checkoutReference, /^COD-/);

  const shipments = await Shipment.find({ order: order._id });
  assert.equal(shipments.length, 1);
  assert.equal(shipments[0].status, 'placed');
  assert.equal((await Product.findById(house._id)).stock, 18);
  assert.equal((await call('GET', '/cart', { token: ada })).data.items.length, 0);

  // It shows in the customer's list and the admin's open orders.
  const mine = (await call('GET', '/orders', { token: ada })).data.orders[0];
  assert.equal(mine.paymentStatus, 'cod');
  assert.equal(mine.progress, 'Order placed'); // what the tracking list shows
  const listed = (await call('GET', '/admin/orders', { token: admin })).data.orders;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].payment, 'Pay on delivery');
  assert.equal(listed[0].shipments.length, 1); // so the list can offer the next step
  assert.equal(listed[0].shipments[0].status, 'placed');
});

test('delivering a pay-on-delivery order marks it paid, and the vendor is credited as usual', async () => {
  await addToCart(vend._id, 1); // 50,000 + 2,000
  const placed = await checkout({ paymentMethod: 'cod' });
  const order = await Order.findOne({ orderNumber: placed.data.orderNumber });
  const shipment = await Shipment.findOne({ order: order._id });
  const step = (status) => call('PATCH', `/admin/shipments/${shipment._id}/status`, { token: admin, body: { status } });

  for (const s of ['confirmed', 'packed', 'shipped']) {
    assert.equal((await step(s)).status, 200);
    assert.equal((await Order.findById(order._id)).paymentStatus, 'cod'); // not paid until it arrives
  }
  assert.equal((await step('delivered')).status, 200);

  const done = await Order.findById(order._id);
  assert.equal(done.paymentStatus, 'paid');
  assert.equal(done.paidAmount, 52000);
  assert.ok(done.paidAt);
  assert.equal((await Vendor.findById(vendorId)).walletBalance, 45000); // 50,000 less 10%
});

test('if one shipment is cancelled, only what was delivered counts as collected', async () => {
  await addToCart(house._id, 1); // 40,000
  await addToCart(vend._id, 1); // 50,000; two sellers, so 2 x 2,000 delivery
  const placed = await checkout({ paymentMethod: 'cod' });
  const order = await Order.findOne({ orderNumber: placed.data.orderNumber });
  assert.equal(order.total, 94000);
  const [a, b] = await Shipment.find({ order: order._id }).sort({ _id: 1 });
  const move = (s, status) => call('PATCH', `/admin/shipments/${s._id}/status`, { token: admin, body: { status } });

  await move(a, 'cancelled');
  assert.equal((await Order.findById(order._id)).paymentStatus, 'cod');
  for (const s of ['confirmed', 'packed', 'shipped', 'delivered']) await move(b, s);

  const done = await Order.findById(order._id);
  assert.equal(done.paymentStatus, 'paid');
  const delivered = await Shipment.findById(b._id);
  const expected = delivered.deliveryFee + delivered.items.reduce((n, i) => n + i.price * i.quantity, 0);
  assert.equal(done.paidAmount, expected);
});

test('the admin controls pay on delivery: on or off, and the largest order allowed', async () => {
  const settings = (await call('GET', '/settings')).data;
  assert.equal(settings.codEnabled, true);
  assert.equal(settings.codMaxAmount, 100000);

  await setCod({ codMaxAmount: 50000 });
  await addToCart(vend._id, 1); // 52,000 with delivery
  const tooBig = await checkout({ paymentMethod: 'cod' });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.data.message, /up to .50,000/);
  // The same cart can still be paid for online.
  const online = await checkout();
  assert.equal(online.status, 201);
  assert.match(online.data.checkoutUrl, /checkout\.korapay\.com/);
  assert.equal(charges, 1);
  assert.equal((await Order.findOne({ orderNumber: online.data.orderNumber })).paymentStatus, 'pending');

  await setCod({ codEnabled: false, codMaxAmount: 100000 });
  assert.equal((await call('GET', '/settings')).data.codEnabled, false);
  await addToCart(house._id, 1);
  const off = await checkout({ paymentMethod: 'cod' });
  assert.equal(off.status, 400);
  assert.match(off.data.message, /not available/);

  await setCod({ codEnabled: true, codMaxAmount: 100000 });
});

test('a customer cannot stack up pay-on-delivery orders, and a bad method is refused', async () => {
  await Cart.deleteMany({}); // start from an empty cart
  assert.equal((await checkout({ paymentMethod: 'cash' })).status, 400);

  // Some are still open from the tests above; top up to the limit of 3, and the next one is refused.
  const open = await Order.countDocuments({ paymentStatus: 'cod' });
  for (let i = open; i < 3; i += 1) {
    await addToCart(house._id, 1);
    assert.equal((await checkout({ paymentMethod: 'cod' })).status, 201);
  }
  await addToCart(house._id, 1);
  const blocked = await checkout({ paymentMethod: 'cod' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.message, /waiting to be delivered/);
  assert.equal((await checkout()).status, 201); // online still works
});
