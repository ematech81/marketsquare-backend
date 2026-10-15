const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

// This file checks the store rules, so it turns the minimum order on (the shared setup turns it off).
process.env.JWT_SECRET = 'test-secret';
process.env.KORAPAY_PREFIX = 'SQM';
process.env.MIN_ORDER_AMOUNT = '30000';

const app = require('../src/app');
const korapay = require('../src/services/korapay');
const mailer = require('../src/services/mailer');
const sms = require('../src/services/sms');
const User = require('../src/models/User');

let mongod;
let server;
let base;
let adminToken;
let ada;
let cheap;
let pricey;

const call = async (method, path, { token, body } = {}) => {
  const res = await realFetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};
const realFetch = globalThis.fetch;
const address = { fullName: 'Ada Obi', phone: '+2348031234567', street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' };

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  korapay.initializeCharge = async (a) => ({ checkout_url: `https://checkout.korapay.com/${a.reference}/pay` });

  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  adminToken = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  ada = (await call('POST', '/auth/register', { body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' } })).data.token;
  await call('PUT', '/admin/delivery-zones', { token: adminToken, body: { zones: [{ state: 'Lagos', fee: 2500, estimatedDays: 2 }] } });
  const cat = (await call('POST', '/admin/categories', { token: adminToken, body: { name: 'Fashion' } })).data.category;
  const make = (title, price) =>
    call('POST', '/admin/products', {
      token: adminToken,
      body: { title, description: `${title} description`, category: cat._id, price, stock: 20, images: [{ url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' }] },
    }).then((r) => r.data.product);
  cheap = await make('Socks', 5000);
  pricey = await make('Agbada', 30000);
});

after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('the store rules are public', async () => {
  const res = await call('GET', '/settings');
  assert.deepEqual(res.data, { minOrderAmount: 30000, returnDays: 30, requireListingApproval: true, codEnabled: true, codMaxAmount: 100000 });
});

test('orders under the minimum are refused, with a clear message', async () => {
  await call('POST', '/cart/items', { token: ada, body: { productId: cheap._id, quantity: 2 } }); // 10,000
  const low = await call('POST', '/orders/checkout', { token: ada, body: { address } });
  assert.equal(low.status, 400);
  assert.match(low.data.message, /minimum order is ₦30,000/);
  assert.match(low.data.message, /Add ₦20,000 more/);

  // Delivery does not count towards the minimum, only the items.
  await call('POST', '/cart/items', { token: ada, body: { productId: cheap._id, quantity: 4 } }); // 30,000 in total
  const ok = await call('POST', '/orders/checkout', { token: ada, body: { address } });
  assert.equal(ok.status, 201);
});

test('Brevo gets the right request, and a failure never throws', async () => {
  process.env.BREVO_API_KEY = 'test-key';
  process.env.MAIL_FROM = '"Market Square" <shop@example.com>';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => '' };
  };

  assert.deepEqual(mailer.parseFrom('Market Square <shop@example.com>'), { name: 'Market Square', email: 'shop@example.com' });
  assert.deepEqual(mailer.parseFrom('plain@example.com'), { name: 'Square Market', email: 'plain@example.com' });

  const result = await mailer.sendMail({ to: 'buyer@example.com', subject: 'Hello', text: 'Hi', html: '<p>Hi</p>' });
  assert.deepEqual(result, { sent: true });
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].options.headers['api-key'], 'test-key');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.sender, { name: 'Market Square', email: 'shop@example.com' });
  assert.deepEqual(body.to, [{ email: 'buyer@example.com' }]);
  assert.equal(body.htmlContent, '<p>Hi</p>');

  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  assert.deepEqual(await mailer.sendMail({ to: 'buyer@example.com', subject: 'Hello', text: 'Hi', html: '<p>Hi</p>' }), { failed: true });

  process.env.BREVO_API_KEY = '';
  globalThis.fetch = realFetch;
});

test('BulkSMS gets the right request, and numbers are cleaned up', async () => {
  assert.equal(sms.normalizePhone('+2348031234567'), '2348031234567');
  assert.equal(sms.normalizePhone('08031234567'), '2348031234567');
  assert.equal(sms.normalizePhone('2348031234567'), '2348031234567');

  process.env.SMS_PROVIDER = 'bulksms';
  process.env.BULKSMS_API_TOKEN = 'sms-token';
  process.env.BULKSMS_SENDER_ID = 'MyShop';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => '' };
  };

  assert.deepEqual(await sms.sendSms({ to: '08031234567', message: 'Your order is on its way.' }), { sent: true });
  assert.equal(calls[0].url, 'https://www.bulksmsnigeria.com/api/v2/sms');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sms-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { from: 'MyShop', to: '2348031234567', body: 'Your order is on its way.' });

  globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => 'sender not registered' });
  assert.deepEqual(await sms.sendSms({ to: '08031234567', message: 'x' }), { failed: true });
  assert.deepEqual(await sms.sendSms({ to: '', message: 'x' }), { skipped: true });

  // Sender IDs must be alphanumeric: symbols and spaces are stripped, the length is capped, digits-only is refused.
  assert.equal(sms.cleanSenderId('Square Mkt!'), 'SquareMkt');
  assert.equal(sms.cleanSenderId('SquareMarketNigeria'), 'SquareMarke');
  assert.equal(sms.cleanSenderId('Shop-NG_1'), 'ShopNG1');
  assert.equal(sms.cleanSenderId('08031234567'), '');
  assert.equal(sms.cleanSenderId(''), '');

  process.env.BULKSMS_SENDER_ID = 'My Shop!';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => '' };
  };
  await sms.sendSms({ to: '08031234567', message: 'x' });
  assert.equal(JSON.parse(calls.at(-1).options.body).from, 'MyShop');

  const before = calls.length;
  process.env.BULKSMS_SENDER_ID = '12345';
  assert.deepEqual(await sms.sendSms({ to: '08031234567', message: 'x' }), { failed: true });
  assert.equal(calls.length, before); // nothing was sent with a bad sender ID
  process.env.BULKSMS_SENDER_ID = 'MyShop';

  process.env.SMS_PROVIDER = '';
  process.env.BULKSMS_API_TOKEN = '';
  globalThis.fetch = realFetch;
});

test('pricey products pass the minimum on their own', async () => {
  await call('POST', '/cart/items', { token: ada, body: { productId: pricey._id, quantity: 1 } });
  const res = await call('POST', '/orders/checkout', { token: ada, body: { address } });
  assert.equal(res.status, 201);
});
