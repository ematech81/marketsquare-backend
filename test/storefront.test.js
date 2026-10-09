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
const User = require('../src/models/User');
const Product = require('../src/models/Product');

let mongod;
let server;
let base;
let adminToken;
let token;
const sent = [];

const call = async (method, path, { token: t, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

const image = { url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' };
const make = (cat, title, price, stock, extra = {}) =>
  call('POST', '/admin/products', {
    token: adminToken,
    body: { title, description: `${title} description text`, category: cat._id, price, stock, images: [image], ...extra },
  }).then((r) => r.data.product);

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  korapay.initializeCharge = async (a) => {
    sent.push(a);
    return { checkout_url: 'https://checkout.korapay.com/x/pay' };
  };

  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  adminToken = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  token = (await call('POST', '/auth/register', { body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' } })).data.token;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('catalog filters: several categories, in stock only, rating, rating sort', async () => {
  const fashion = (await call('POST', '/admin/categories', { token: adminToken, body: { name: 'Fashion' } })).data.category;
  const beauty = (await call('POST', '/admin/categories', { token: adminToken, body: { name: 'Beauty' } })).data.category;
  const home = (await call('POST', '/admin/categories', { token: adminToken, body: { name: 'Home' } })).data.category;

  const shirt = await make(fashion, 'Shirt', 5000, 4);
  const cream = await make(beauty, 'Cream', 3000, 0);
  await make(home, 'Mug', 2000, 9);
  await Product.updateOne({ _id: shirt._id }, { ratingAverage: 4.8, ratingCount: 5 });
  await Product.updateOne({ _id: cream._id }, { ratingAverage: 4.1, ratingCount: 2 });

  assert.equal((await call('GET', '/products?category=fashion,beauty')).data.total, 2);
  assert.equal((await call('GET', '/products?category=fashion,beauty&inStock=1')).data.total, 1);
  assert.equal((await call('GET', '/products?minRating=4.5')).data.total, 1);
  assert.equal((await call('GET', '/products?sort=rating')).data.products[0].title, 'Shirt');
  assert.equal((await call('GET', '/products?category=nope,alsonope')).data.total, 0);
});

test('checkout keeps the landmark and sends the chosen email to KoraPay', async () => {
  await call('PUT', '/admin/delivery-zones', { token: adminToken, body: { zones: [{ state: 'Lagos', fee: 2500, estimatedDays: 2 }] } });
  const mug = (await call('GET', '/products?q=mug')).data.products[0];
  await call('POST', '/cart/items', { token, body: { productId: mug.id, quantity: 1 } });

  const res = await call('POST', '/orders/checkout', {
    token,
    body: {
      email: 'Receipts@Example.com',
      address: { fullName: 'Ada Obi', phone: '+2348031234567', street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos', landmark: 'Near the roundabout' },
    },
  });
  assert.equal(res.status, 201);
  assert.equal(sent.at(-1).customer.email, 'receipts@example.com');

  const order = await call('GET', `/orders/${res.data.orderNumber}`, { token });
  assert.equal(order.data.order.address.landmark, 'Near the roundabout');
});

test('admin overview summarises sales, applications and recent orders', async () => {
  assert.equal((await call('GET', '/admin/overview', { token })).status, 403);
  const res = await call('GET', '/admin/overview', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.kpis.sales, 0);
  assert.equal(res.data.kpis.products, 3);
  assert.equal(res.data.recentOrders.length, 1);
  assert.equal(res.data.recentOrders[0].status, 'Awaiting payment');
  assert.equal(res.data.recentOrders[0].customer, 'Ada Obi');
});
