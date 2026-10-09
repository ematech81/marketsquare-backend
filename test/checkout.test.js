const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
process.env.KORAPAY_SECRET_KEY = 'sk_test_unit';
process.env.KORAPAY_PREFIX = 'SQM';
process.env.KORAPAY_CURRENCY = 'NGN';
process.env.ROUTER_FORWARD_SECRET = 'router-secret';

const app = require('../src/app');
const korapay = require('../src/services/korapay');
const User = require('../src/models/User');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const Shipment = require('../src/models/Shipment');

let mongod;
let server;
let base;
let adminToken;
let ada;
let adaToken;
let shirt;
const initCalls = [];

const call = async (method, path, { token, body, headers } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

const sign = (data) => crypto.createHmac('sha256', process.env.KORAPAY_SECRET_KEY).update(JSON.stringify(data)).digest('hex');
const webhook = (event, data, { signature, routerSecret = 'router-secret' } = {}) =>
  call('POST', '/webhooks/korapay', {
    body: { event, data },
    headers: { 'x-korapay-signature': signature ?? sign(data), 'x-router-secret': routerSecret },
  });

const address = { fullName: 'Ada Obi', phone: '08031234567', street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' };

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;

  korapay.initializeCharge = async (args) => {
    initCalls.push(args);
    return { reference: args.reference, checkout_url: `https://checkout.korapay.com/${args.reference}/pay` };
  };

  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  adminToken = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;

  const reg = await call('POST', '/auth/register', { body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' } });
  adaToken = reg.data.token;
  ada = reg.data.user;

  const cat = (await call('POST', '/admin/categories', { token: adminToken, body: { name: 'Fashion' } })).data.category;
  shirt = (
    await call('POST', '/admin/products', {
      token: adminToken,
      body: {
        title: 'Ankara Shirt',
        description: 'Hand-stitched Ankara shirt',
        category: cat._id,
        price: 15000,
        stock: 3,
        images: [{ url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' }],
        variants: [{ name: 'Size', options: ['M', 'L'] }],
      },
    })
  ).data.product;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('delivery fees are set by admin and shown publicly', async () => {
  assert.equal((await call('PUT', '/admin/delivery-zones', { token: adaToken, body: { zones: [] } })).status, 403);
  assert.equal((await call('PUT', '/admin/delivery-zones', { token: adminToken, body: { zones: [{ state: 'Narnia', fee: 1000 }] } })).status, 400);

  const res = await call('PUT', '/admin/delivery-zones', {
    token: adminToken,
    body: { zones: [{ state: 'Lagos', fee: 2500, estimatedDays: 2 }, { state: 'Abia', fee: 4000, estimatedDays: 4 }] },
  });
  assert.equal(res.status, 200);
  const pub = await call('GET', '/delivery-zones');
  assert.deepEqual(pub.data.zones.map((z) => z.state), ['Abia', 'Lagos']);
});

test('cart enforces options and stock', async () => {
  assert.equal((await call('GET', '/cart')).status, 401);

  const noSize = await call('POST', '/cart/items', { token: adaToken, body: { productId: shirt._id, quantity: 1 } });
  assert.equal(noSize.status, 400);

  const add = await call('POST', '/cart/items', { token: adaToken, body: { productId: shirt._id, quantity: 2, options: [{ name: 'Size', value: 'M' }] } });
  assert.equal(add.status, 201);
  assert.equal(add.data.subtotal, 30000);
  assert.equal(add.data.items[0].product.seller.name, 'Square Market');

  // Asking for more than the stock of 3 in total is refused.
  const tooMany = await call('POST', '/cart/items', { token: adaToken, body: { productId: shirt._id, quantity: 2, options: [{ name: 'Size', value: 'M' }] } });
  assert.equal(tooMany.status, 409);

  // A different size is a separate line.
  const other = await call('POST', '/cart/items', { token: adaToken, body: { productId: shirt._id, quantity: 1, options: [{ name: 'Size', value: 'L' }] } });
  assert.equal(other.data.items.length, 2);
  const removed = await call('DELETE', `/cart/items/${other.data.items[1].id}`, { token: adaToken });
  assert.equal(removed.data.items.length, 1);
});

test('checkout builds the order on the server and starts a KoraPay payment', async () => {
  const noZone = await call('POST', '/orders/checkout', { token: adaToken, body: { address: { ...address, state: 'Kano' } } });
  assert.equal(noZone.status, 400);

  const res = await call('POST', '/orders/checkout', { token: adaToken, body: { address } });
  assert.equal(res.status, 201);
  assert.match(res.data.checkoutUrl, /^https:\/\/checkout\.korapay\.com\//);

  const sent = initCalls.at(-1);
  assert.match(sent.reference, /^SQM-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(sent.amount, 32500); // 2 x 15,000 + 2,500 delivery, worked out by the server
  assert.equal(sent.currency, 'NGN');
  assert.equal(sent.notificationUrl, undefined);
  assert.equal(sent.notification_url, undefined);

  const order = await Order.findOne({ orderNumber: res.data.orderNumber });
  assert.equal(order.checkoutReference, sent.reference);
  assert.equal(order.paymentStatus, 'pending');
  assert.equal(order.deliveryTotal, 2500);
});

test('webhook rejects bad router secret and bad signature', async () => {
  const order = await Order.findOne({ paymentStatus: 'pending' });
  const data = { reference: order.checkoutReference, status: 'success', amount: order.total, currency: 'NGN' };

  assert.equal((await webhook('charge.success', data, { routerSecret: 'wrong' })).status, 401);
  assert.equal((await webhook('charge.success', data, { signature: 'f'.repeat(64) })).status, 401);
  assert.equal((await webhook('charge.success', { ...data, amount: 1 }, { signature: sign(data) })).status, 401);
  assert.equal((await Order.findById(order._id)).paymentStatus, 'pending');
});

test('a valid payment webhook fulfils the order once, even if delivered twice', async () => {
  const order = await Order.findOne({ paymentStatus: 'pending' });
  const data = { reference: order.checkoutReference, status: 'success', amount: order.total, currency: 'NGN' };

  assert.equal((await webhook('charge.success', data)).status, 200);
  assert.equal((await webhook('charge.success', data)).status, 200); // router retry

  const paid = await Order.findById(order._id);
  assert.equal(paid.paymentStatus, 'paid');
  assert.equal((await Product.findById(shirt._id)).stock, 1); // 3 - 2, taken once
  const shipments = await Shipment.find({ order: order._id });
  assert.equal(shipments.length, 1);
  assert.equal(shipments[0].deliveryFee, 2500);
  assert.equal(shipments[0].status, 'placed');
  assert.equal((await call('GET', '/cart', { token: adaToken })).data.items.length, 0);

  const mine = await call('GET', `/orders/${paid.orderNumber}`, { token: adaToken });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.order.checkoutReference, undefined);
  assert.equal(mine.data.order.shipments.length, 1);
});

test('unknown references and other customers are handled safely', async () => {
  const data = { reference: 'SQM-does-not-exist', status: 'success', amount: 100, currency: 'NGN' };
  const res = await webhook('charge.success', data);
  assert.equal(res.status, 200);
  assert.equal(res.data.ignored, true);

  const other = (await call('POST', '/auth/register', { body: { name: 'Bayo', email: 'bayo@example.com', phone: '08099999999', password: 'password123' } })).data.token;
  const order = await Order.findOne({ paymentStatus: 'paid' });
  assert.equal((await call('GET', `/orders/${order.orderNumber}`, { token: other })).status, 404);
});

test('a payment for the wrong amount is flagged, not fulfilled', async () => {
  await call('POST', '/cart/items', { token: adaToken, body: { productId: shirt._id, quantity: 1, options: [{ name: 'Size', value: 'M' }] } });
  const res = await call('POST', '/orders/checkout', { token: adaToken, body: { address } });
  const order = await Order.findOne({ orderNumber: res.data.orderNumber });

  const data = { reference: order.checkoutReference, status: 'success', amount: 100, currency: 'NGN' };
  assert.equal((await webhook('charge.success', data)).status, 200);

  const after = await Order.findById(order._id);
  assert.equal(after.paymentStatus, 'mismatch');
  assert.match(after.needsAttention, /order total/);
  assert.equal(await Shipment.countDocuments({ order: order._id }), 0);
  assert.equal((await Product.findById(shirt._id)).stock, 1);
});

test('the return page can confirm payment itself if the webhook is late', async () => {
  const res = await call('POST', '/orders/checkout', { token: adaToken, body: { address } });
  const order = await Order.findOne({ orderNumber: res.data.orderNumber });

  korapay.verifyCharge = async () => ({ status: 'success', amount: order.total });
  const verified = await call('POST', `/orders/${order.orderNumber}/verify`, { token: adaToken });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.order.paymentStatus, 'paid');
  assert.equal((await Product.findById(shirt._id)).stock, 0);
  assert.equal(await Shipment.countDocuments({ order: order._id }), 1);
});

test('checkout is refused when an item is out of stock', async () => {
  const add = await call('POST', '/cart/items', { token: adaToken, body: { productId: shirt._id, quantity: 1, options: [{ name: 'Size', value: 'M' }] } });
  assert.equal(add.status, 409);
});
