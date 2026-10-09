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

const application = {
  businessName: 'Ada Fabrics',
  category: 'Fashion',
  state: 'Lagos',
  city: 'Ikeja',
  phone: '08031234567',
  idType: 'nin',
  idNumber: '12345678901',
  bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Ada Obi' },
};

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('register, sign in and read own account', async () => {
  const reg = await call('POST', '/auth/register', {
    body: { name: 'Ada Obi', email: 'Ada@Example.com', phone: '08031234567', password: 'password123' },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.role, 'customer');
  assert.equal(reg.data.user.email, 'ada@example.com');
  assert.equal(reg.data.user.passwordHash, undefined);

  const dup = await call('POST', '/auth/register', {
    body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' },
  });
  assert.equal(dup.status, 409);

  const bad = await call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'wrong-password' } });
  assert.equal(bad.status, 401);

  const login = await call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'password123' } });
  assert.equal(login.status, 200);

  const me = await call('GET', '/auth/me', { token: login.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'ada@example.com');

  assert.equal((await call('GET', '/auth/me')).status, 401);
});

test('validation rejects weak input', async () => {
  const res = await call('POST', '/auth/register', {
    body: { name: 'A', email: 'nope', phone: '123', password: 'short' },
  });
  assert.equal(res.status, 400);
});

test('vendor applies, admin approves, vendor role is granted', async () => {
  const login = await call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'password123' } });
  const token = login.data.token;

  const bad = await call('POST', '/vendors/apply', { token, body: { ...application, bank: { ...application.bank, accountNumber: '123' } } });
  assert.equal(bad.status, 400);

  const apply = await call('POST', '/vendors/apply', { token, body: application });
  assert.equal(apply.status, 201);
  assert.equal(apply.data.vendor.status, 'pending');
  const vendorId = apply.data.vendor._id;

  assert.equal((await call('POST', '/vendors/apply', { token, body: application })).status, 409);

  // Customers cannot reach admin routes.
  assert.equal((await call('GET', '/admin/vendors', { token })).status, 403);

  await User.create({
    name: 'Admin',
    email: 'admin@example.com',
    phone: '08000000000',
    passwordHash: await bcrypt.hash('adminpass123', 4),
    role: 'admin',
  });
  const admin = await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } });
  const adminToken = admin.data.token;

  const pending = await call('GET', '/admin/vendors?status=pending', { token: adminToken });
  assert.equal(pending.data.vendors.length, 1);
  assert.equal(pending.data.vendors[0].user.email, 'ada@example.com');

  const noReason = await call('PATCH', `/admin/vendors/${vendorId}/status`, { token: adminToken, body: { status: 'rejected' } });
  assert.equal(noReason.status, 400);

  const approve = await call('PATCH', `/admin/vendors/${vendorId}/status`, { token: adminToken, body: { status: 'approved' } });
  assert.equal(approve.status, 200);

  const me = await call('GET', '/auth/me', { token });
  assert.equal(me.data.user.role, 'vendor');
  assert.equal(me.data.vendor.status, 'approved');
});

test('rejected applicant can resubmit', async () => {
  await call('POST', '/auth/register', {
    body: { name: 'Bayo', email: 'bayo@example.com', phone: '08099999999', password: 'password123' },
  });
  const token = (await call('POST', '/auth/login', { body: { email: 'bayo@example.com', password: 'password123' } })).data.token;
  const vendorId = (await call('POST', '/vendors/apply', { token, body: application })).data.vendor._id;

  const adminToken = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  await call('PATCH', `/admin/vendors/${vendorId}/status`, { token: adminToken, body: { status: 'rejected', reason: 'ID number does not match' } });

  const mine = await call('GET', '/vendors/me', { token });
  assert.equal(mine.data.vendor.status, 'rejected');
  assert.equal(mine.data.vendor.rejectionReason, 'ID number does not match');

  const redo = await call('PUT', '/vendors/me', { token, body: application });
  assert.equal(redo.status, 200);
  assert.equal(redo.data.vendor.status, 'pending');
});
