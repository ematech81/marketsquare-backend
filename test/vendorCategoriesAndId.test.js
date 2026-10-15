const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

const application = (extra = {}) => ({
  businessName: 'Baby Bliss',
  category: 'Fashion',
  state: 'Lagos',
  city: 'Ikeja',
  phone: '08011112222',
  idType: 'nin',
  idNumber: '12345678901',
  bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Baby Bliss' },
  ...extra,
});

const customer = async (n) =>
  (await call('POST', '/auth/register', { body: { name: `Person ${n}`, email: `p${n}@example.com`, phone: `0803000000${n}`, password: 'password123' } })).data.token;

const names = async () => (await call('GET', '/categories')).data.categories.map((c) => c.name);

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  admin = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  await call('POST', '/admin/categories', { token: admin, body: { name: 'Fashion' } });
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('an applicant who cannot find their category adds a new one to the shared list', async () => {
  const t = await customer(1);
  const res = await call('POST', '/vendors/apply', { token: t, body: application({ category: '  Baby   Care ' }) });
  assert.equal(res.status, 201);
  assert.equal(res.data.vendor.category, 'Baby Care'); // tidied
  assert.ok((await names()).includes('Baby Care'));
});

test('the same category in another spelling is the same category, not a copy', async () => {
  const t = await customer(2);
  const res = await call('POST', '/vendors/apply', { token: t, body: application({ category: 'baby care', businessName: 'Tiny Toes' }) });
  assert.equal(res.status, 201);
  assert.equal(res.data.vendor.category, 'Baby Care'); // the existing one
  assert.equal((await names()).filter((n) => n.toLowerCase() === 'baby care').length, 1);

  const t3 = await customer(3);
  await call('POST', '/vendors/apply', { token: t3, body: application({ category: 'FASHION', businessName: 'Style Hub' }) });
  assert.equal((await names()).filter((n) => n.toLowerCase() === 'fashion').length, 1);
});

test('vendors and admins can add a category while listing; customers cannot; names are checked', async () => {
  const t = await customer(4);
  assert.equal((await call('POST', '/categories', { token: t, body: { name: 'Pets' } })).status, 403);
  assert.equal((await call('POST', '/categories', { body: { name: 'Pets' } })).status, 401);

  const made = await call('POST', '/categories', { token: admin, body: { name: 'Pet Supplies' } });
  assert.equal(made.status, 201);
  assert.equal(made.data.created, true);
  const again = await call('POST', '/categories', { token: admin, body: { name: 'pet supplies' } });
  assert.equal(again.status, 200);
  assert.equal(again.data.created, false);
  assert.equal(again.data.category._id, made.data.category._id);

  assert.equal((await call('POST', '/categories', { token: admin, body: { name: 'x' } })).status, 400);
  assert.equal((await call('POST', '/categories', { token: admin, body: { name: '<script>alert(1)</script>' } })).status, 400);
  assert.equal((await call('POST', '/categories', { token: admin, body: { name: 'a'.repeat(41) } })).status, 400);
  assert.equal((await call('POST', '/categories', { token: admin, body: {} })).status, 400);
});

test('a NIN must be exactly 11 digits; other IDs must look like an ID', async () => {
  const t = await customer(5);
  const apply = (extra) => call('POST', '/vendors/apply', { token: t, body: application({ businessName: 'Id Test', ...extra }) });

  for (const bad of ['1234', '123456789012', '1234567890a', '12345 67890']) {
    const r = await apply({ idNumber: bad });
    assert.equal(r.status, 400, bad);
    assert.match(r.data.message, /NIN must be exactly 11 digits/);
  }
  assert.equal((await apply({ idType: 'passport', idNumber: 'A123' })).status, 400);
  assert.equal((await apply({ idType: 'passport', idNumber: 'A!2345678' })).status, 400);

  const ok = await apply({ idType: 'passport', idNumber: 'A 12345678' }); // spaces are dropped
  assert.equal(ok.status, 201);
  assert.equal(ok.data.vendor.idNumber, 'A12345678');
});
