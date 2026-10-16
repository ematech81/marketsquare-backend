const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';

const app = require('../src/app');
const mailer = require('../src/services/mailer');
const User = require('../src/models/User');
const Product = require('../src/models/Product');
const Vendor = require('../src/models/Vendor');
const Shipment = require('../src/models/Shipment');
const Category = require('../src/models/Category');
const Notification = require('../src/models/Notification');

let mongod;
let server;
let base;
let admin;
let ada;
let zara; // the vendor's login
let zaraUser;
let product;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};
// Notifications are sent in the background, so give them a moment to land.
const settle = () => new Promise((r) => setTimeout(r, 200));
const address = { fullName: 'Ada Obi', phone: '+2348031234567', street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' };
const titles = async (token) => (await call('GET', '/notifications', { token })).data.notifications.map((n) => n.title);

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  mailer.setTransport({ sendMail: async () => undefined });

  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  admin = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  ada = (await call('POST', '/auth/register', { body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' } })).data.token;
  await call('PUT', '/admin/delivery-zones', { token: admin, body: { zones: [{ state: 'Lagos', fee: 2000, estimatedDays: 2 }] } });

  const cat = await Category.create({ name: 'Gadget', slug: 'gadget' });
  zaraUser = await User.create({ name: 'Zara', email: 'zara@example.com', phone: '08011110001', passwordHash: await bcrypt.hash('password123', 4), role: 'vendor' });
  const vendor = await Vendor.create({
    user: zaraUser._id,
    businessName: 'Zara Tech',
    category: 'Gadget',
    state: 'Lagos',
    city: 'Ikeja',
    phone: '08011110001',
    idType: 'nin',
    idNumber: '12345678901',
    bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Zara' },
    status: 'approved',
  });
  zara = (await call('POST', '/auth/login', { body: { email: 'zara@example.com', password: 'password123' } })).data.token;
  product = await Product.create({
    title: 'Vendor Laptop',
    slug: 'vendor-laptop',
    description: 'A good laptop to buy',
    category: cat._id,
    price: 50000,
    stock: 10,
    status: 'active',
    vendor: vendor._id,
    images: [{ url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' }],
  });
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('you must be signed in to read notifications', async () => {
  assert.equal((await call('GET', '/notifications')).status, 401);
  assert.equal((await call('GET', '/notifications/unread-count')).status, 401);
});

test('placing an order tells the customer, the admin and the vendor', async () => {
  await call('POST', '/cart/items', { token: ada, body: { productId: product._id, quantity: 1 } });
  const placed = await call('POST', '/orders/checkout', { token: ada, body: { address, paymentMethod: 'cod' } });
  assert.equal(placed.status, 201);
  await settle();

  const mine = (await call('GET', '/notifications', { token: ada })).data;
  assert.equal(mine.unread, 1);
  assert.equal(mine.notifications[0].title, 'Order placed');
  assert.equal(mine.notifications[0].link, `/orders/${placed.data.orderNumber}`);
  assert.equal(mine.notifications[0].read, false);

  assert.ok((await titles(admin)).some((t) => /New pay on delivery order/.test(t)));
  assert.ok((await titles(zara)).some((t) => /New order/.test(t)));
  // Nobody sees anybody else's.
  assert.ok(!(await titles(ada)).some((t) => /New order/.test(t)));
});

test('each step the admin ticks tells the customer', async () => {
  const shipment = await Shipment.findOne({});
  const step = (status) => call('PATCH', `/admin/shipments/${shipment._id}/status`, { token: admin, body: { status } });
  for (const s of ['confirmed', 'packed', 'shipped', 'delivered']) assert.equal((await step(s)).status, 200);
  await settle();
  const seen = await titles(ada);
  for (const t of ['Order confirmed', 'Order packed', 'Order on its way', 'Order delivered']) assert.ok(seen.includes(t), t);
});

test('reading: one at a time, all at once, and never someone else\'s', async () => {
  const before = (await call('GET', '/notifications', { token: ada })).data;
  assert.ok(before.unread >= 5);

  const first = before.notifications[0];
  const one = await call('PATCH', `/notifications/${first.id}/read`, { token: ada });
  assert.equal(one.status, 200);
  assert.equal(one.data.notification.read, true);
  assert.equal(one.data.unread, before.unread - 1);

  // The vendor cannot mark the customer's notification, and a made-up id is not found.
  assert.equal((await call('PATCH', `/notifications/${before.notifications[1].id}/read`, { token: zara })).status, 404);
  assert.equal((await call('PATCH', '/notifications/nope/read', { token: ada })).status, 404);
  assert.equal((await Notification.findById(before.notifications[1].id)).read, false);

  assert.equal((await call('POST', '/notifications/read-all', { token: ada })).data.unread, 0);
  assert.equal((await call('GET', '/notifications/unread-count', { token: ada })).data.unread, 0);
  // The vendor's own were untouched.
  assert.ok((await call('GET', '/notifications/unread-count', { token: zara })).data.unread > 0);
});

test('a vendor application tells the admin, and the decision tells the applicant', async () => {
  const sam = (await call('POST', '/auth/register', { body: { name: 'Sam Eze', email: 'sam@example.com', phone: '08032223333', password: 'password123' } })).data.token;
  const applied = await call('POST', '/vendors/apply', {
    token: sam,
    body: {
      businessName: 'Sam Wears',
      category: 'Gadget',
      state: 'Lagos',
      city: 'Ikeja',
      phone: '08032223333',
      idType: 'nin',
      idNumber: '12345678901',
      bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Sam Eze' },
    },
  });
  assert.equal(applied.status, 201);
  await settle();
  assert.ok((await titles(admin)).includes('New vendor application'));

  await call('PATCH', `/admin/vendors/${applied.data.vendor._id}/status`, { token: admin, body: { status: 'approved' } });
  await settle();
  assert.ok((await titles(sam)).includes('Your vendor application is approved'));
});
