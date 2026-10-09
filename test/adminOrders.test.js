const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
process.env.KORAPAY_SECRET_KEY = 'sk_test_unit';
process.env.KORAPAY_PREFIX = 'SQM';
delete process.env.ROUTER_FORWARD_SECRET;

const app = require('../src/app');
const korapay = require('../src/services/korapay');
const User = require('../src/models/User');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');

let mongod;
let server;
let base;
let adminToken;
let ada;
let product;

const call = async (method, path, { token, body, headers } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

const sign = (data) => crypto.createHmac('sha256', process.env.KORAPAY_SECRET_KEY).update(JSON.stringify(data)).digest('hex');
const address = { fullName: 'Ada Obi', phone: '+2348031234567', street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' };

// Buys `quantity` of the product through the real checkout and webhook.
async function placePaidOrder(quantity) {
  await call('POST', '/cart/items', { token: ada, body: { productId: product._id, quantity } });
  const res = await call('POST', '/orders/checkout', { token: ada, body: { address } });
  const order = await Order.findOne({ orderNumber: res.data.orderNumber });
  const data = { reference: order.checkoutReference, status: 'success', amount: order.total, currency: 'NGN' };
  await call('POST', '/webhooks/korapay', { body: { event: 'charge.success', data }, headers: { 'x-korapay-signature': sign(data) } });
  return res.data.orderNumber;
}

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
  product = (
    await call('POST', '/admin/products', {
      token: adminToken,
      body: {
        title: 'Ankara Shirt',
        description: 'Hand-stitched Ankara shirt',
        category: cat._id,
        price: 15000,
        stock: 10,
        images: [{ url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' }],
      },
    })
  ).data.product;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('only admins can see or change orders', async () => {
  assert.equal((await call('GET', '/admin/orders', { token: ada })).status, 403);
  assert.equal((await call('GET', '/admin/orders')).status, 401);
});

test('a paid order shows up as new, and moves through each step in order', async () => {
  const orderNumber = await placePaidOrder(2);

  const list = await call('GET', '/admin/orders?filter=open', { token: adminToken });
  assert.equal(list.data.orders.length, 1);
  assert.equal(list.data.orders[0].status, 'New');
  assert.equal(list.data.counts.toConfirm, 1);

  const detail = await call('GET', `/admin/orders/${orderNumber}`, { token: adminToken });
  assert.equal(detail.data.order.user.phone, '08031234567');
  assert.equal(detail.data.order.shipments[0].vendorName, 'Square Market');
  const shipmentId = detail.data.order.shipments[0]._id;

  // No skipping steps.
  const skip = await call('PATCH', `/admin/shipments/${shipmentId}/status`, { token: adminToken, body: { status: 'shipped' } });
  assert.equal(skip.status, 409);

  for (const status of ['confirmed', 'packed', 'shipped']) {
    const res = await call('PATCH', `/admin/shipments/${shipmentId}/status`, { token: adminToken, body: { status } });
    assert.equal(res.status, 200);
    assert.equal(res.data.shipment.status, status);
  }

  // The customer's tracking page sees the same state.
  const mine = await call('GET', `/orders/${orderNumber}`, { token: ada });
  assert.equal(mine.data.order.shipments[0].status, 'shipped');
  assert.deepEqual(mine.data.order.shipments[0].timeline.map((t) => t.status), ['placed', 'confirmed', 'packed', 'shipped']);

  const delivered = await call('PATCH', `/admin/shipments/${shipmentId}/status`, { token: adminToken, body: { status: 'delivered' } });
  assert.equal(delivered.status, 200);
  assert.equal((await call('PATCH', `/admin/shipments/${shipmentId}/status`, { token: adminToken, body: { status: 'cancelled' } })).status, 409);

  const done = await call('GET', '/admin/orders?filter=done', { token: adminToken });
  assert.equal(done.data.orders[0].status, 'Delivered');
  assert.equal((await call('GET', '/admin/orders?filter=open', { token: adminToken })).data.orders.length, 0);
});

test('cancelling a shipment puts the stock back, only once', async () => {
  const before = (await Product.findById(product._id)).stock;
  const orderNumber = await placePaidOrder(3);
  assert.equal((await Product.findById(product._id)).stock, before - 3);

  const detail = await call('GET', `/admin/orders/${orderNumber}`, { token: adminToken });
  const shipmentId = detail.data.order.shipments[0]._id;

  const cancel = await call('PATCH', `/admin/shipments/${shipmentId}/status`, { token: adminToken, body: { status: 'cancelled' } });
  assert.equal(cancel.status, 200);
  assert.equal((await Product.findById(product._id)).stock, before);

  // A second cancel is refused and cannot restock again.
  assert.equal((await call('PATCH', `/admin/shipments/${shipmentId}/status`, { token: adminToken, body: { status: 'cancelled' } })).status, 409);
  assert.equal((await Product.findById(product._id)).stock, before);

  const list = await call('GET', '/admin/orders?filter=done', { token: adminToken });
  assert.ok(list.data.orders.some((o) => o.orderNumber === orderNumber && o.status === 'Cancelled'));
});
