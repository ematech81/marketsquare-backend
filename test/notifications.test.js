const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
process.env.KORAPAY_SECRET_KEY = 'sk_test_unit';
process.env.KORAPAY_PREFIX = 'SQM';
process.env.ADMIN_ALERT_EMAIL = 'owner@example.com';
delete process.env.ROUTER_FORWARD_SECRET;

const app = require('../src/app');
const korapay = require('../src/services/korapay');
const mailer = require('../src/services/mailer');
const User = require('../src/models/User');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');

let mongod;
let server;
let base;
let adminToken;
let ada;
let product;
let orderNumber;
let shipmentId;
const outbox = [];

const call = async (method, path, { token, body, headers } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};
const sign = (data) => crypto.createHmac('sha256', process.env.KORAPAY_SECRET_KEY).update(JSON.stringify(data)).digest('hex');
const sentTo = (to) => outbox.filter((m) => m.to === to);

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  korapay.initializeCharge = async (a) => ({ checkout_url: `https://checkout.korapay.com/${a.reference}/pay` });
  mailer.setTransport({ sendMail: async (m) => outbox.push(m) });

  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  adminToken = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  ada = (await call('POST', '/auth/register', { body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' } })).data.token;

  await call('PUT', '/admin/delivery-zones', { token: adminToken, body: { zones: [{ state: 'Lagos', fee: 2500, estimatedDays: 2 }] } });
  const cat = (await call('POST', '/admin/categories', { token: adminToken, body: { name: 'Fashion' } })).data.category;
  product = (
    await call('POST', '/admin/products', {
      token: adminToken,
      body: { title: 'Ankara Shirt', description: 'Hand-stitched Ankara shirt', category: cat._id, price: 15000, stock: 10, images: [{ url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' }] },
    })
  ).data.product;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('a paid order emails the customer a receipt and alerts the owner', async () => {
  await call('POST', '/cart/items', { token: ada, body: { productId: product._id, quantity: 1 } });
  const res = await call('POST', '/orders/checkout', {
    token: ada,
    body: { email: 'receipts@example.com', address: { fullName: 'Ada Obi', phone: '+2348031234567', street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' } },
  });
  orderNumber = res.data.orderNumber;
  const order = await Order.findOne({ orderNumber });
  const data = { reference: order.checkoutReference, status: 'success', amount: order.total, currency: 'NGN' };
  await call('POST', '/webhooks/korapay', { body: { event: 'charge.success', data }, headers: { 'x-korapay-signature': sign(data) } });
  // A repeated webhook must not send the emails again.
  await call('POST', '/webhooks/korapay', { body: { event: 'charge.success', data }, headers: { 'x-korapay-signature': sign(data) } });
  await new Promise((r) => setTimeout(r, 200));
  await mailer.idle();

  const receipt = sentTo('receipts@example.com');
  assert.equal(receipt.length, 1);
  assert.match(receipt[0].subject, new RegExp(orderNumber));
  assert.match(receipt[0].text, /Total paid: ₦17,500/);
  assert.match(receipt[0].html, /Follow your order/);

  const alert = sentTo('owner@example.com');
  assert.equal(alert.length, 1);
  assert.match(alert[0].subject, /New order/);

  shipmentId = (await call('GET', `/admin/orders/${orderNumber}`, { token: adminToken })).data.order.shipments[0]._id;
});

test('shipping and delivering emails the customer', async () => {
  const before = outbox.length;
  for (const status of ['confirmed', 'packed']) await call('PATCH', `/admin/shipments/${shipmentId}/status`, { token: adminToken, body: { status } });
  await mailer.idle();
  assert.equal(outbox.length, before); // no email for the quiet steps

  await call('PATCH', `/admin/shipments/${shipmentId}/status`, { token: adminToken, body: { status: 'shipped' } });
  await new Promise((r) => setTimeout(r, 100));
  await mailer.idle();
  assert.match(sentTo('receipts@example.com').at(-1).subject, /on its way/);

  // Not delivered yet, so reviewing is not allowed.
  const early = await call('GET', `/products/${product.slug}/reviews/eligibility`, { token: ada });
  assert.equal(early.data.canReview, false);
  assert.equal((await call('POST', `/products/${product.slug}/reviews`, { token: ada, body: { rating: 5 } })).status, 403);

  await call('PATCH', `/admin/shipments/${shipmentId}/status`, { token: adminToken, body: { status: 'delivered' } });
  await new Promise((r) => setTimeout(r, 100));
  await mailer.idle();
  assert.match(sentTo('receipts@example.com').at(-1).subject, /has been delivered/);
});

test('verified buyers can review once, and the product rating updates', async () => {
  assert.equal((await call('GET', `/products/${product.slug}/reviews/eligibility`, { token: ada })).data.canReview, true);

  const bad = await call('POST', `/products/${product.slug}/reviews`, { token: ada, body: { rating: 9 } });
  assert.equal(bad.status, 400);

  const ok = await call('POST', `/products/${product.slug}/reviews`, { token: ada, body: { rating: 4, body: 'Lovely fabric, fits well.' } });
  assert.equal(ok.status, 201);
  assert.equal((await call('POST', `/products/${product.slug}/reviews`, { token: ada, body: { rating: 5 } })).status, 403);

  const list = await call('GET', `/products/${product.slug}/reviews`);
  assert.equal(list.data.count, 1);
  assert.equal(list.data.average, 4);
  assert.equal(list.data.reviews[0].author, 'Ada O.');
  assert.equal((await Product.findById(product._id)).ratingAverage, 4);

  // A stranger who never bought it cannot review.
  const bayo = (await call('POST', '/auth/register', { body: { name: 'Bayo K', email: 'bayo@example.com', phone: '08099999999', password: 'password123' } })).data.token;
  assert.equal((await call('POST', `/products/${product.slug}/reviews`, { token: bayo, body: { rating: 1 } })).status, 403);
});

test('forgotten passwords can be reset with the emailed link, once', async () => {
  const unknown = await call('POST', '/auth/forgot', { body: { email: 'nobody@example.com' } });
  assert.equal(unknown.status, 200); // same answer, so emails cannot be probed
  await mailer.idle();
  assert.equal(sentTo('nobody@example.com').length, 0);

  const ask = await call('POST', '/auth/forgot', { body: { email: 'ada@example.com' } });
  assert.equal(ask.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  await mailer.idle();
  const mail = sentTo('ada@example.com').at(-1);
  const token = mail.text.match(/token=([a-f0-9]+)/)[1];

  assert.equal((await call('POST', '/auth/reset', { body: { token: 'a'.repeat(64), password: 'newpassword1' } })).status, 400);
  assert.equal((await call('POST', '/auth/reset', { body: { token, password: 'short' } })).status, 400);
  assert.equal((await call('POST', '/auth/reset', { body: { token, password: 'newpassword1' } })).status, 200);
  assert.equal((await call('POST', '/auth/reset', { body: { token, password: 'anotherpass1' } })).status, 400); // used up

  assert.equal((await call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'password123' } })).status, 401);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'newpassword1' } })).status, 200);
});

test('vendor decisions email the applicant', async () => {
  const dayo = (await call('POST', '/auth/register', { body: { name: 'Dayo A', email: 'dayo@example.com', phone: '08011112222', password: 'password123' } })).data.token;
  const apply = await call('POST', '/vendors/apply', {
    token: dayo,
    body: { businessName: 'Dayo Wears', category: 'Fashion', state: 'Lagos', city: 'Ikeja', phone: '08011112222', idType: 'nin', idNumber: '12345678901', bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Dayo A' } },
  });
  await call('PATCH', `/admin/vendors/${apply.data.vendor._id}/status`, { token: adminToken, body: { status: 'rejected', reason: 'ID number does not match' } });
  await new Promise((r) => setTimeout(r, 100));
  await mailer.idle();
  assert.match(sentTo('dayo@example.com').at(-1).text, /ID number does not match/);
});

test('admin sees customers with what they have spent', async () => {
  assert.equal((await call('GET', '/admin/customers', { token: ada })).status, 403);
  const res = await call('GET', '/admin/customers', { token: adminToken });
  const adaRow = res.data.customers.find((c) => c.email === 'ada@example.com');
  assert.equal(adaRow.orders, 1);
  assert.equal(adaRow.spent, 17500);
});

test('rate limiting can be switched on to slow down guessing', async () => {
  delete process.env.DISABLE_RATE_LIMIT;
  const statuses = [];
  for (let i = 0; i < 35; i++) {
    statuses.push((await call('POST', '/auth/login', { body: { email: 'ghost@example.com', password: 'wrongwrong1' } })).status);
  }
  process.env.DISABLE_RATE_LIMIT = '1';
  assert.ok(statuses.includes(429), 'expected a 429 after too many attempts');
});
