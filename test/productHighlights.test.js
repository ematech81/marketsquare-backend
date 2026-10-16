const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';

const app = require('../src/app');
const User = require('../src/models/User');
const Vendor = require('../src/models/Vendor');
const Product = require('../src/models/Product');
const Category = require('../src/models/Category');

let mongod;
let server;
let base;
let admin;
let category;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  admin = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  category = await Category.create({ name: 'Shoes', slug: 'shoes' });
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

const body = (extra = {}) => ({
  title: 'Blue Canvas Shoes',
  description: 'High quality canvas shoes for every day.',
  category: String(category._id),
  price: 13400,
  stock: 5,
  images: [{ url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' }],
  status: 'active',
  ...extra,
});

test('key features are saved, tidied and shown on the product page data', async () => {
  const made = await call('POST', '/admin/products', { token: admin, body: body({ highlights: ['  Lightweight and non-slip ', 'Easy to put on'] }) });
  assert.equal(made.status, 201);
  const shown = (await call('GET', `/products/${made.data.product.slug}`)).data.product;
  assert.deepEqual(shown.highlights, ['Lightweight and non-slip', 'Easy to put on']);

  // Left out, it is just an empty list.
  const plain = await call('POST', '/admin/products', { token: admin, body: body({ title: 'Plain Shoes' }) });
  assert.deepEqual((await call('GET', `/products/${plain.data.product.slug}`)).data.product.highlights, []);
});

test('key features are limited to 8 lines of 200 characters', async () => {
  const nine = Array.from({ length: 9 }, (_, i) => `Feature ${i}`);
  const many = await call('POST', '/admin/products', { token: admin, body: body({ title: 'Too Many', highlights: nine }) });
  assert.equal(many.status, 400);
  assert.match(many.data.message, /Up to 8 key features/);
  const long = await call('POST', '/admin/products', { token: admin, body: body({ title: 'Too Long', highlights: ['x'.repeat(201)] }) });
  assert.equal(long.status, 400);
});

test('a store shows since when the vendor joined, for the seller card', async () => {
  const owner = await User.create({ name: 'Zara', email: 'z@example.com', phone: '08011110001', passwordHash: 'x', role: 'vendor' });
  const vendor = await Vendor.create({
    user: owner._id, businessName: 'Zara Shoes', category: 'Shoes', state: 'Lagos', city: 'Ikeja', phone: '08011110001',
    idType: 'nin', idNumber: '12345678901', bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Zara' }, status: 'approved',
  });
  await Product.create({ title: 'Zara Sneakers', slug: 'zara-sneakers', description: 'Nice sneakers', category: category._id, price: 9000, stock: 3, status: 'active', vendor: vendor._id, images: [{ url: 'https://res.cloudinary.com/demo/image/upload/b.jpg' }] });
  const store = (await call('GET', `/stores/${vendor._id}`)).data.store;
  assert.equal(store.city, 'Ikeja');
  assert.equal(store.productCount, 1);
  assert.ok(store.since);
});
