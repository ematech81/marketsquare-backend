const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';

const app = require('../src/app');
const User = require('../src/models/User');

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

const image = { url: 'https://res.cloudinary.com/demo/image/upload/ankara-shirt-ab12cd.jpg', publicId: 'ankara-shirt-ab12cd', alt: 'Blue Ankara shirt, front view' };
const body = (extra = {}) => ({
  title: 'Ankara Shirt',
  description: '## About\n\nA **hand-stitched** shirt.\n\n- Cotton\n- Made in Lagos',
  category: category._id,
  price: 15000,
  stock: 5,
  images: [image],
  status: 'active',
  ...extra,
});

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  admin = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  category = (await call('POST', '/admin/categories', { token: admin, body: { name: 'Fashion' } })).data.category;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('new products get a clean web address made from the title, with a number if it is taken', async () => {
  const first = await call('POST', '/admin/products', { token: admin, body: body() });
  assert.equal(first.status, 201);
  assert.equal(first.data.product.slug, 'ankara-shirt');

  const second = await call('POST', '/admin/products', { token: admin, body: body() });
  assert.equal(second.data.product.slug, 'ankara-shirt-2');

  const custom = await call('POST', '/admin/products', { token: admin, body: body({ title: 'Agbada Set', slug: 'royal-agbada-for-men' }) });
  assert.equal(custom.data.product.slug, 'royal-agbada-for-men');
});

test('search details are saved and shown publicly: brand, tags, details, alt text and the search title', async () => {
  const res = await call('POST', '/admin/products', {
    token: admin,
    body: body({
      title: 'Hisense Washing Machine',
      brand: 'Hisense',
      sku: 'HS-WM-7KG',
      gtin: '6921727123456',
      tags: ['Washing Machine', 'washing machine', 'Home Appliances', 'hisense'],
      details: [{ label: 'Capacity', value: '7 kg' }, { label: 'Warranty', value: '12 months' }],
      seoTitle: 'Hisense 7kg Washing Machine Price in Nigeria',
      seoDescription: 'Buy the Hisense 7kg washing machine in Nigeria. Delivery to every state.',
    }),
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data.product.tags, ['washing machine', 'home appliances', 'hisense']); // lowercase, no repeats

  const pub = await call('GET', `/products/${res.data.product.slug}`);
  const p = pub.data.product;
  assert.equal(p.brand, 'Hisense');
  assert.equal(p.gtin, '6921727123456');
  assert.equal(p.seoTitle, 'Hisense 7kg Washing Machine Price in Nigeria');
  assert.equal(p.details[0].label, 'Capacity');
  assert.equal(p.images[0].alt, 'Blue Ankara shirt, front view');
  assert.ok(p.updatedAt);

  // Shoppers (and Google's visitors) can search by brand or tag, not just the title.
  assert.equal((await call('GET', '/products?q=hisense')).data.total, 1);
  assert.equal((await call('GET', '/products?q=home%20appliances')).data.total, 1);
});

test('bad search details are refused with a clear message', async () => {
  const badSlug = await call('POST', '/admin/products', { token: admin, body: body({ slug: 'Bad Slug!' }) });
  assert.equal(badSlug.status, 400);
  assert.match(badSlug.data.message, /slug/);
  assert.equal((await call('POST', '/admin/products', { token: admin, body: body({ gtin: '12ab' }) })).status, 400);
  assert.equal((await call('POST', '/admin/products', { token: admin, body: body({ seoTitle: 'x'.repeat(71) }) })).status, 400);
  assert.equal((await call('POST', '/admin/products', { token: admin, body: body({ images: [{ ...image, alt: 'y'.repeat(126) }] }) })).status, 400);
  assert.equal((await call('POST', '/admin/products', { token: admin, body: body({ tags: Array.from({ length: 16 }, (_, i) => `tag${i}`) }) })).status, 400);
});

test('changing the web address keeps the old link working', async () => {
  const made = await call('POST', '/admin/products', { token: admin, body: body({ title: 'Leather Sandals' }) });
  const id = made.data.product._id;
  assert.equal(made.data.product.slug, 'leather-sandals');

  const moved = await call('PUT', `/admin/products/${id}`, { token: admin, body: body({ title: 'Leather Sandals', slug: 'handmade-leather-sandals-nigeria' }) });
  assert.equal(moved.data.product.slug, 'handmade-leather-sandals-nigeria');
  assert.deepEqual(moved.data.product.oldSlugs, ['leather-sandals']);

  // The old address still finds it, and tells the website the new address so it can redirect.
  const viaOld = await call('GET', '/products/leather-sandals');
  assert.equal(viaOld.status, 200);
  assert.equal(viaOld.data.product.slug, 'handmade-leather-sandals-nigeria');

  // Another product cannot take an address that used to belong to this one.
  const clash = await call('POST', '/admin/products', { token: admin, body: body({ title: 'Leather Sandals' }) });
  assert.equal(clash.data.product.slug, 'leather-sandals-2');

  // Saving again without touching the address leaves it alone.
  const again = await call('PUT', `/admin/products/${id}`, { token: admin, body: body({ title: 'Leather Sandals Deluxe' }) });
  assert.equal(again.data.product.slug, 'handmade-leather-sandals-nigeria');
});

test('optional search details can be cleared again', async () => {
  const made = await call('POST', '/admin/products', { token: admin, body: body({ title: 'Clearable Item', brand: 'Acme', seoTitle: 'Custom title', gtin: '6921727123456' }) });
  const id = made.data.product._id;
  const cleared = await call('PUT', `/admin/products/${id}`, { token: admin, body: body({ title: 'Clearable Item', brand: '', seoTitle: '', gtin: '' }) });
  assert.equal(cleared.status, 200);
  const raw = await call('GET', `/admin/products/${id}`, { token: admin });
  assert.equal(raw.data.product.brand, undefined);
  assert.equal(raw.data.product.seoTitle, undefined);
  assert.equal(raw.data.product.gtin, undefined);
});

test('photo uploads are signed with a file name made from the product title', async () => {
  process.env.CLOUDINARY_CLOUD_NAME = 'democloud';
  process.env.CLOUDINARY_API_KEY = '12345';
  process.env.CLOUDINARY_API_SECRET = 'topsecret';

  const res = await call('POST', '/admin/uploads/sign', { token: admin, body: { name: 'Hisense 7kg Washing Machine!' } });
  assert.equal(res.status, 200);
  assert.match(res.data.publicId, /^hisense-7kg-washing-machine-[0-9a-f]{6}$/);
  const expected = crypto
    .createHash('sha1')
    .update(`folder=${res.data.folder}&public_id=${res.data.publicId}&timestamp=${res.data.timestamp}topsecret`)
    .digest('hex');
  assert.equal(res.data.signature, expected);

  // With no title yet, the upload still works without a custom file name.
  const plain = await call('POST', '/admin/uploads/sign', { token: admin });
  assert.equal(plain.data.publicId, undefined);
  assert.equal(plain.data.signature, crypto.createHash('sha1').update(`folder=${plain.data.folder}&timestamp=${plain.data.timestamp}topsecret`).digest('hex'));

  process.env.CLOUDINARY_CLOUD_NAME = '';
  process.env.CLOUDINARY_API_KEY = '';
  process.env.CLOUDINARY_API_SECRET = '';
});
