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
let customer;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

const banner = (n, extra = {}) => ({
  title: `Promo ${n}`,
  image: { url: `https://res.cloudinary.com/demo/image/upload/promo-${n}.jpg`, publicId: `promo-${n}` },
  alt: `Promotion number ${n}`,
  link: '/products',
  ...extra,
});

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  admin = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  customer = (await call('POST', '/auth/register', { body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' } })).data.token;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('only the admin manages banners, and the home page starts empty', async () => {
  assert.deepEqual((await call('GET', '/banners')).data.banners, []);
  assert.equal((await call('POST', '/admin/banners', { body: banner(1) })).status, 401);
  assert.equal((await call('POST', '/admin/banners', { token: customer, body: banner(1) })).status, 403);
  assert.equal((await call('GET', '/admin/banners', { token: customer })).status, 403);
});

test('banners are checked: description, image address and link', async () => {
  const post = (b) => call('POST', '/admin/banners', { token: admin, body: b });
  assert.equal((await post(banner(1, { alt: '' }))).status, 400);
  assert.equal((await post(banner(1, { title: '' }))).status, 400);
  assert.equal((await post(banner(1, { image: { url: 'http://insecure.example/a.jpg' } }))).status, 400);
  assert.equal((await post(banner(1, { image: { url: 'not a url' } }))).status, 400);
  // Links: a page on this site or https only. Nothing that runs code.
  assert.equal((await post(banner(1, { link: 'javascript:alert(1)' }))).status, 400);
  assert.equal((await post(banner(1, { link: '//evil.example/x' }))).status, 400);
  assert.equal((await post(banner(1, { link: 'http://plain.example' }))).status, 400);
  assert.equal((await post(banner(1, { link: 'products' }))).status, 400);
  assert.equal((await post(banner(1, { link: 'https://shop.example/sale' }))).status, 201);
});

test('the public list shows active banners in order, and hides the admin-only details', async () => {
  await call('POST', '/admin/banners', { token: admin, body: banner(2, { link: '' }) });
  await call('POST', '/admin/banners', { token: admin, body: banner(3, { active: false }) });

  const all = (await call('GET', '/admin/banners', { token: admin })).data;
  assert.equal(all.banners.length, 3);
  assert.equal(all.max, 6);

  const pub = (await call('GET', '/banners')).data.banners;
  assert.equal(pub.length, 2); // the inactive one is hidden
  assert.equal(pub[0].link, 'https://shop.example/sale');
  assert.equal(pub[1].link, undefined); // no link when left empty
  assert.equal(pub[0].alt, 'Promotion number 1');
  assert.equal(pub[0].title, undefined);
  assert.equal(pub[0].active, undefined);
});

test('banners can be reordered, switched on and off, edited, and given a phone image', async () => {
  const ids = (await call('GET', '/admin/banners', { token: admin })).data.banners.map((b) => b._id);

  const reordered = await call('PATCH', '/admin/banners-order', { token: admin, body: { ids: [ids[1], ids[0], ids[2]] } });
  assert.equal(reordered.status, 200);
  assert.equal((await call('GET', '/banners')).data.banners[0].alt, 'Promotion number 2');

  const on = await call('PATCH', `/admin/banners/${ids[2]}/active`, { token: admin, body: { active: true } });
  assert.equal(on.data.banner.active, true);
  assert.equal((await call('GET', '/banners')).data.banners.length, 3);

  const edit = await call('PUT', `/admin/banners/${ids[0]}`, {
    token: admin,
    body: banner(1, { alt: 'A new description', mobileImage: { url: 'https://res.cloudinary.com/demo/image/upload/promo-1-mobile.jpg' } }),
  });
  assert.equal(edit.status, 200);
  const pub = (await call('GET', '/banners')).data.banners.find((b) => b.alt === 'A new description');
  assert.match(pub.mobileImage, /promo-1-mobile/);

  // Taking the phone image away again works too.
  await call('PUT', `/admin/banners/${ids[0]}`, { token: admin, body: banner(1) });
  assert.equal((await call('GET', '/banners')).data.banners.find((b) => b.alt === 'Promotion number 1').mobileImage, undefined);
});

test('at most 6 banners, and removing one makes room', async () => {
  const post = (n) => call('POST', '/admin/banners', { token: admin, body: banner(n) });
  await post(4);
  await post(5);
  await post(6);
  assert.equal((await call('GET', '/admin/banners', { token: admin })).data.banners.length, 6);

  const seventh = await post(7);
  assert.equal(seventh.status, 409);
  assert.match(seventh.data.message, /6 banners/);

  const first = (await call('GET', '/admin/banners', { token: admin })).data.banners[0]._id;
  assert.equal((await call('DELETE', `/admin/banners/${first}`, { token: admin })).status, 200);
  assert.equal((await post(7)).status, 201);
  assert.equal((await call('DELETE', `/admin/banners/${first}`, { token: admin })).status, 404);
});

test('the size of each design is kept, so the home page can fit it', async () => {
  const made = await call('POST', '/admin/banners', { token: admin, body: { ...banner(8), image: { url: 'https://res.cloudinary.com/demo/image/upload/sized.jpg', width: 940, height: 348 } } });
  assert.equal(made.status, 409); // the list is already full from the previous test
  const first = (await call('GET', '/admin/banners', { token: admin })).data.banners[0]._id;
  await call('DELETE', '/admin/banners/' + first, { token: admin });
  const ok = await call('POST', '/admin/banners', { token: admin, body: { ...banner(8), image: { url: 'https://res.cloudinary.com/demo/image/upload/sized.jpg', width: 940, height: 348 } } });
  assert.equal(ok.status, 201);
  const shown = (await call('GET', '/banners')).data.banners.find((b) => b.alt === 'Promotion number 8');
  assert.equal(shown.width, 940);
  assert.equal(shown.height, 348);
  assert.equal((await call('POST', '/admin/banners', { token: admin, body: { ...banner(9), image: { url: 'https://res.cloudinary.com/demo/image/upload/x.jpg', width: -5 } } })).status, 400);
});

test('banner uploads are signed into their own folder with a file name from the title', async () => {
  process.env.CLOUDINARY_CLOUD_NAME = 'democloud';
  process.env.CLOUDINARY_API_KEY = '12345';
  process.env.CLOUDINARY_API_SECRET = 'topsecret';

  assert.equal((await call('POST', '/admin/banners-upload-sign', { token: customer })).status, 403);
  const res = await call('POST', '/admin/banners-upload-sign', { token: admin, body: { name: 'October Promo' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.folder, 'squaremarket/banners');
  assert.match(res.data.publicId, /^october-promo-[0-9a-f]{6}$/);
  const expected = crypto.createHash('sha1').update(`folder=squaremarket/banners&public_id=${res.data.publicId}&timestamp=${res.data.timestamp}topsecret`).digest('hex');
  assert.equal(res.data.signature, expected);

  process.env.CLOUDINARY_CLOUD_NAME = '';
  process.env.CLOUDINARY_API_KEY = '';
  process.env.CLOUDINARY_API_SECRET = '';
});
