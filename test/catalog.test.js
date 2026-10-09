const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
delete process.env.CLOUDINARY_API_SECRET;

const app = require('../src/app');
const User = require('../src/models/User');

let mongod;
let server;
let base;
let adminToken;
let customerToken;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

const image = { url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', publicId: 'sample' };

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;

  await User.create({
    name: 'Admin',
    email: 'admin@example.com',
    phone: '08000000000',
    passwordHash: await bcrypt.hash('adminpass123', 4),
    role: 'admin',
  });
  adminToken = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;

  customerToken = (
    await call('POST', '/auth/register', {
      body: { name: 'Ada', email: 'ada@example.com', phone: '08031234567', password: 'password123' },
    })
  ).data.token;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('only admins can manage the catalog', async () => {
  assert.equal((await call('POST', '/admin/categories', { body: { name: 'Fashion' } })).status, 401);
  assert.equal((await call('POST', '/admin/categories', { token: customerToken, body: { name: 'Fashion' } })).status, 403);
});

test('admin lists a product and shoppers can find it', async () => {
  const fashion = (await call('POST', '/admin/categories', { token: adminToken, body: { name: 'Fashion & Style' } })).data.category;
  assert.equal(fashion.slug, 'fashion-style');
  const tech = (await call('POST', '/admin/categories', { token: adminToken, body: { name: 'Electronics' } })).data.category;

  assert.equal((await call('POST', '/admin/categories', { token: adminToken, body: { name: 'Electronics' } })).status, 409);

  const noImage = await call('POST', '/admin/products', {
    token: adminToken,
    body: { title: 'Ankara Shirt', description: 'Hand-stitched Ankara shirt', category: fashion._id, price: 15000, stock: 5 },
  });
  assert.equal(noImage.status, 400);

  const shirt = await call('POST', '/admin/products', {
    token: adminToken,
    body: {
      title: 'Ankara Shirt',
      description: 'Hand-stitched Ankara shirt',
      category: fashion._id,
      price: 15000,
      compareAtPrice: 20000,
      images: [image],
      variants: [{ name: 'Size', options: ['M', 'L'] }],
      stock: 5,
    },
  });
  assert.equal(shirt.status, 201);
  assert.match(shirt.data.product.slug, /^ankara-shirt-[a-f0-9]{6}$/);

  await call('POST', '/admin/products', {
    token: adminToken,
    body: { title: 'Phone Charger', description: 'Fast 20W charger', category: tech._id, price: 6000, images: [image], stock: 0 },
  });
  await call('POST', '/admin/products', {
    token: adminToken,
    body: { title: 'Secret Draft', description: 'Not ready for sale', category: tech._id, price: 1000, stock: 1, status: 'draft' },
  });

  const all = await call('GET', '/products');
  assert.equal(all.status, 200);
  assert.equal(all.data.total, 2); // the draft is hidden
  assert.equal(all.data.products[0].seller.name, 'Square Market');

  assert.equal((await call('GET', '/products?q=ankara')).data.total, 1);
  assert.equal((await call('GET', '/products?q=(')).data.total, 0);
  assert.equal((await call('GET', '/products?category=electronics')).data.total, 1);
  assert.equal((await call('GET', '/products?category=nope')).data.total, 0);
  assert.equal((await call('GET', '/products?minPrice=10000')).data.total, 1);

  const cheap = await call('GET', '/products?sort=price_asc');
  assert.equal(cheap.data.products[0].title, 'Phone Charger');
  assert.equal(cheap.data.products[0].inStock, false);

  const page = await call('GET', '/products?limit=1&page=2');
  assert.equal(page.data.pages, 2);
  assert.equal(page.data.products.length, 1);

  const detail = await call('GET', `/products/${shirt.data.product.slug}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.product.category.name, 'Fashion & Style');
  assert.equal((await call('GET', '/products/missing-slug')).status, 404);

  const cats = await call('GET', '/categories');
  assert.equal(cats.data.categories.length, 2);

  // Editing keeps the link stable; unpublishing hides it.
  const edit = await call('PUT', `/admin/products/${shirt.data.product._id}`, {
    token: adminToken,
    body: { title: 'Ankara Shirt Deluxe', description: 'Hand-stitched Ankara shirt', category: fashion._id, price: 16000, images: [image], stock: 5, status: 'draft' },
  });
  assert.equal(edit.data.product.slug, shirt.data.product.slug);
  assert.equal((await call('GET', `/products/${shirt.data.product.slug}`)).status, 404);

  assert.equal((await call('DELETE', `/admin/categories/${fashion._id}`, { token: adminToken })).status, 409);
});

test('upload signing explains when Cloudinary is not configured', async () => {
  const res = await call('POST', '/admin/uploads/sign', { token: adminToken });
  assert.equal(res.status, 503);
});
