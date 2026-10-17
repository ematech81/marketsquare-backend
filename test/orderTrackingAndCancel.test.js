const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.JWT_SECRET = 'test-secret';
process.env.KORAPAY_SECRET_KEY = 'sk_test_unit';
process.env.KORAPAY_PREFIX = 'SQM';

const app = require('../src/app');
const korapay = require('../src/services/korapay');
const mailer = require('../src/services/mailer');
const User = require('../src/models/User');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const Vendor = require('../src/models/Vendor');
const Shipment = require('../src/models/Shipment');
const Category = require('../src/models/Category');
const Cart = require('../src/models/Cart');

let mongod;
let server;
let base;
let admin;
let ada;
let eve;
let category;
const vendors = {}; // name -> { token, vendor, product }

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
const settle = () => new Promise((r) => setTimeout(r, 300));
const titles = async (token) => (await call('GET', '/notifications', { token })).data.notifications.map((n) => n.title);
const count = (list, title) => list.filter((t) => t === title).length;

async function makeVendor(key, name, email, phone, price) {
  const user = await User.create({ name, email, phone, passwordHash: await bcrypt.hash('password123', 4), role: 'vendor' });
  const vendor = await Vendor.create({
    user: user._id, businessName: `${name} Stores`, category: 'Gadget', state: 'Lagos', city: 'Ikeja', phone,
    idType: 'nin', idNumber: '12345678901', bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: name }, status: 'approved',
  });
  const token = (await call('POST', '/auth/login', { body: { email, password: 'password123' } })).data.token;
  const product = await Product.create({
    title: `${name} Item`, slug: `${key}-item`, description: 'A good product to buy', category: category._id, price, stock: 10, status: 'active', vendor: vendor._id,
    images: [{ url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' }],
  });
  vendors[key] = { token, vendor, product };
}

// Puts products in the cart and checks out. Returns the order. `pay` makes it a paid online order.
async function order(products, { pay = false, cod = false, token = ada } = {}) {
  await Cart.deleteMany({});
  for (const p of products) await call('POST', '/cart/items', { token: ada, body: { productId: p._id, quantity: 1 } });
  const res = await call('POST', '/orders/checkout', { token, body: { address, ...(cod ? { paymentMethod: 'cod' } : {}) } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const o = await Order.findOne({ orderNumber: res.data.orderNumber });
  if (pay) {
    const data = { reference: o.checkoutReference, status: 'success', amount: o.total, currency: 'NGN' };
    await call('POST', '/webhooks/korapay', { body: { event: 'charge.success', data }, headers: { 'x-korapay-signature': sign(data) } });
  }
  return { order: await Order.findById(o._id), number: res.data.orderNumber };
}

const vendorStep = (key, shipment, status) => call('PATCH', `/vendor/shipments/${shipment._id}/status`, { token: vendors[key].token, body: { status } });
const adminStep = (shipment, status) => call('PATCH', `/admin/shipments/${shipment._id}/status`, { token: admin, body: { status } });
const shipmentOf = async (o, key) => Shipment.findOne({ order: o._id, vendor: vendors[key].vendor._id });

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  korapay.initializeCharge = async (a) => ({ checkout_url: `https://checkout.korapay.com/${a.reference}/pay` });
  mailer.setTransport({ sendMail: async () => undefined });

  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  admin = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  ada = (await call('POST', '/auth/register', { body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' } })).data.token;
  eve = (await call('POST', '/auth/register', { body: { name: 'Eve Obi', email: 'eve@example.com', phone: '08035556666', password: 'password123' } })).data.token;
  await call('PUT', '/admin/delivery-zones', { token: admin, body: { zones: [{ state: 'Lagos', fee: 2000, estimatedDays: 2 }] } });
  await call('PUT', '/admin/settings', { token: admin, body: { defaultCommissionRate: 10, minPayoutAmount: 10000, payoutHoldDays: 0, newVendorExtraHoldDays: 0 } });

  category = await Category.create({ name: 'Gadget', slug: 'gadget' });
  await makeVendor('amara', 'Amara', 'amara@example.com', '08011110001', 20000);
  await makeVendor('bola', 'Bola', 'bola@example.com', '08011110002', 30000);
  await makeVendor('chidi', 'Chidi', 'chidi@example.com', '08011110003', 40000);
  vendors.house = { product: await Product.create({ title: 'House Item', slug: 'house-item', description: 'A good product to buy', category: category._id, price: 10000, stock: 10, status: 'active', images: [{ url: 'https://res.cloudinary.com/demo/image/upload/h.jpg' }] }) };
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

// ---------------------------------------------------------------- one order, one tracking

test('the customer sees one order, however many vendors it came from: no vendor names, packages only numbered', async () => {
  const { number } = await order([vendors.amara.product, vendors.bola.product, vendors.chidi.product, vendors.house.product], { pay: true });
  const res = await call('GET', `/orders/${number}`, { token: ada });
  const text = JSON.stringify(res.data);
  for (const name of ['Amara Stores', 'Bola Stores', 'Chidi Stores']) assert.equal(text.includes(name), false, name);
  assert.equal(res.data.order.items.length, 4);
  assert.ok(res.data.order.items.every((i) => i.vendor === undefined));
  assert.equal(res.data.order.deliveries, undefined);
  assert.deepEqual(res.data.order.shipments.map((s) => s.package), [1, 2, 3, 4]);
  assert.ok(res.data.order.shipments.every((s) => s.vendorName === undefined));
  assert.equal(res.data.order.progress.stage, 'placed');
  assert.equal(res.data.order.progress.packages.live, 4);
});

test('the order only moves on when every package has, and the customer hears about the order, not each package', async () => {
  const { order: o, number } = await order([vendors.amara.product, vendors.bola.product, vendors.chidi.product], { pay: true });
  const progress = async () => (await call('GET', `/orders/${number}`, { token: ada })).data.order.progress;
  const before = await titles(ada);

  await vendorStep('amara', await shipmentOf(o, 'amara'), 'confirmed');
  await vendorStep('bola', await shipmentOf(o, 'bola'), 'confirmed');
  assert.equal((await progress()).stage, 'placed'); // one vendor has not confirmed yet
  await vendorStep('chidi', await shipmentOf(o, 'chidi'), 'confirmed');
  assert.equal((await progress()).stage, 'confirmed');

  for (const key of ['amara', 'bola', 'chidi']) await vendorStep(key, await shipmentOf(o, key), 'packed');
  assert.equal((await progress()).stage, 'packed');

  // Square Market collects and ships. The first package out gives one "part of your order" message.
  await adminStep(await shipmentOf(o, 'amara'), 'shipped');
  let p = await progress();
  assert.equal(p.stage, 'packed');
  assert.equal(p.partial, true);
  assert.equal(p.steps.find((s) => s.name === 'shipped').note, '1 of 3 packages are on their way');
  await adminStep(await shipmentOf(o, 'bola'), 'shipped');
  assert.equal((await progress()).stage, 'packed');
  await adminStep(await shipmentOf(o, 'chidi'), 'shipped');
  assert.equal((await progress()).stage, 'shipped');

  for (const key of ['amara', 'bola', 'chidi']) await adminStep(await shipmentOf(o, key), 'delivered');
  assert.equal((await progress()).stage, 'delivered');
  await settle();

  // Count what the customer was told for this order.
  const all = await titles(ada);
  const fresh = (t) => count(all, t) - count(before, t);
  assert.equal(fresh('Order confirmed'), 1);
  assert.equal(fresh('Order packed'), 1);
  assert.equal(fresh('Part of your order is on its way'), 1);
  assert.equal(fresh('Order on its way'), 1);
  assert.equal(fresh('Order delivered'), 1);
});

test('when Square Market delivers, the vendor says it is ready and Square Market is told to collect it', async () => {
  const { order: o, number } = await order([vendors.amara.product], { pay: true });
  const s = await shipmentOf(o, 'amara');
  await vendorStep('amara', s, 'confirmed');
  await settle();
  const readyBefore = count(await titles(admin), 'Ready to collect'); // earlier orders in this file already sent some
  await vendorStep('amara', s, 'packed');
  await settle();
  const notes = (await call('GET', '/notifications', { token: admin })).data.notifications;
  assert.equal(count(notes.map((n) => n.title), 'Ready to collect'), readyBefore + 1); // confirming sent nothing, packing sent one
  const ready = notes.find((n) => n.title === 'Ready to collect' && n.link === `/orders/${number}`);
  assert.ok(ready);
  assert.match(ready.body, /Amara Stores/);
  assert.equal(ready.link, `/orders/${number}`);
  // The vendor cannot ship it; Square Market does.
  const tooSoon = await vendorStep('amara', s, 'shipped');
  assert.equal(tooSoon.status, 403);
  assert.equal((await adminStep(s, 'shipped')).status, 200);
});

test('the order list says where each order is up to', async () => {
  const list = (await call('GET', '/orders', { token: ada })).data.orders;
  const labels = list.map((o) => o.progress);
  assert.ok(labels.includes('Delivered'));
  assert.ok(labels.includes('Order placed'));
});

// ---------------------------------------------------------------- cancelling

test('a paid order can be cancelled before it is packed: stock back, vendors told, refund recorded', async () => {
  const stockBefore = (await Product.findById(vendors.amara.product._id)).stock;
  const { order: o, number } = await order([vendors.amara.product, vendors.bola.product], { pay: true });
  assert.equal((await Product.findById(vendors.amara.product._id)).stock, stockBefore - 1);
  await vendorStep('amara', await shipmentOf(o, 'amara'), 'confirmed'); // confirmed is still fine

  const view = (await call('GET', `/orders/${number}`, { token: ada })).data.order;
  assert.equal(view.canCancel, true);

  assert.equal((await call('POST', `/orders/${number}/cancel`, { token: ada, body: { reason: '' } })).status, 400); // a reason is needed
  assert.equal((await call('POST', `/orders/${number}/cancel`, { token: eve, body: { reason: 'Changed my mind' } })).status, 404); // not their order
  const done = await call('POST', `/orders/${number}/cancel`, { token: ada, body: { reason: 'Changed my mind', note: 'Sorry' } });
  assert.equal(done.status, 200);
  assert.equal(done.data.order.progress.cancelled, true);
  assert.equal(done.data.order.canCancel, false);
  assert.equal(done.data.order.cancelReason, 'Changed my mind');
  assert.equal(done.data.order.refund.status, 'due');
  assert.equal(done.data.order.refund.amount, o.total);

  assert.equal((await Product.findById(vendors.amara.product._id)).stock, stockBefore); // put back
  assert.deepEqual((await Shipment.find({ order: o._id })).map((s) => s.status), ['cancelled', 'cancelled']);
  assert.equal((await call('POST', `/orders/${number}/cancel`, { token: ada, body: { reason: 'Again' } })).status, 409); // only once

  await settle();
  const adminNotes = await titles(admin);
  assert.ok(adminNotes.includes('Refund due'));
  assert.ok(adminNotes.includes('A customer cancelled an order'));
  assert.ok((await titles(vendors.amara.token)).includes(`Order ${number} was cancelled`));
  assert.ok((await titles(ada)).includes('Order cancelled'));

  // The admin sees it as cancelled, with a refund waiting.
  const row = (await call('GET', '/admin/orders?filter=all', { token: admin })).data.orders.find((r) => r.orderNumber === number);
  assert.equal(row.status, 'Cancelled');
  assert.equal(row.refundDue, true);
});

test('once anything is packed or on its way, the customer can no longer cancel', async () => {
  const { order: o, number } = await order([vendors.amara.product, vendors.bola.product], { pay: true });
  const a = await shipmentOf(o, 'amara');
  await vendorStep('amara', a, 'confirmed');
  await vendorStep('amara', a, 'packed');

  const view = (await call('GET', `/orders/${number}`, { token: ada })).data.order;
  assert.equal(view.canCancel, false);
  assert.match(view.cancelBlockedReason, /packed or on its way/);
  const blocked = await call('POST', `/orders/${number}/cancel`, { token: ada, body: { reason: 'Changed my mind' } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.message, /no longer be cancelled/);
});

test('a pay-on-delivery order can be cancelled, and there is nothing to refund', async () => {
  const { number } = await order([vendors.house.product], { cod: true });
  const done = await call('POST', `/orders/${number}/cancel`, { token: ada, body: { reason: 'Ordered by mistake' } });
  assert.equal(done.status, 200);
  assert.equal(done.data.order.refund, undefined);
  assert.equal(done.data.order.progress.cancelled, true);
});

test('an order still waiting for payment is cancelled at once, and a late payment is flagged for a refund', async () => {
  const stockBefore = (await Product.findById(vendors.bola.product._id)).stock;
  const { order: o, number } = await order([vendors.bola.product]); // not paid
  const done = await call('POST', `/orders/${number}/cancel`, { token: ada, body: { reason: 'Found a better price' } });
  assert.equal(done.status, 200);
  assert.equal((await Order.findById(o._id)).paymentStatus, 'cancelled');
  assert.equal(done.data.order.refund, undefined);

  // The customer pays anyway from a page they left open. Nothing is shipped and the money is to be refunded.
  const data = { reference: o.checkoutReference, status: 'success', amount: o.total, currency: 'NGN' };
  assert.equal((await call('POST', '/webhooks/korapay', { body: { event: 'charge.success', data }, headers: { 'x-korapay-signature': sign(data) } })).status, 200);
  const late = await Order.findById(o._id);
  assert.equal(late.paymentStatus, 'cancelled');
  assert.equal(late.refund.status, 'due');
  assert.equal(late.refund.amount, o.total);
  assert.equal(await Shipment.countDocuments({ order: o._id }), 0);
  assert.equal((await Product.findById(vendors.bola.product._id)).stock, stockBefore); // stock was never taken
});

test('a cancelled order can be deleted from the customer list, and the admin can delete it once any refund is sent', async () => {
  const { number } = await order([vendors.amara.product], { pay: true });
  assert.equal((await call('DELETE', `/orders/${number}`, { token: ada })).status, 409); // not cancelled
  await call('POST', `/orders/${number}/cancel`, { token: ada, body: { reason: 'Changed my mind' } });

  assert.equal((await call('DELETE', `/orders/${number}`, { token: eve })).status, 404);
  assert.equal((await call('DELETE', `/orders/${number}`, { token: ada })).status, 200);
  assert.equal((await call('GET', '/orders', { token: ada })).data.orders.some((o) => o.orderNumber === number), false); // gone from their list
  assert.ok(await Order.exists({ orderNumber: number })); // Square Market keeps the record

  // The admin cannot delete it while the refund is still owed.
  assert.equal((await call('DELETE', `/admin/orders/${number}`, { token: ada })).status, 403);
  const owed = await call('DELETE', `/admin/orders/${number}`, { token: admin });
  assert.equal(owed.status, 409);
  assert.match(owed.data.message, /refund is still owed/);

  // Refund it, and the customer is told; then it can be deleted for good.
  assert.equal((await call('POST', `/admin/orders/${number}/refund`, { token: admin, body: { note: 'Sent via KoraPay' } })).status, 200);
  assert.equal((await call('POST', `/admin/orders/${number}/refund`, { token: admin })).status, 409); // only once
  await settle();
  assert.ok((await titles(ada)).includes('Refund sent'));
  assert.equal((await call('DELETE', `/admin/orders/${number}`, { token: admin })).status, 200);
  assert.equal(await Order.exists({ orderNumber: number }), null);
  assert.equal((await call('GET', `/admin/orders/${number}`, { token: admin })).status, 404);
});

test('an order that is still active cannot be deleted, by the customer or the admin', async () => {
  const { number } = await order([vendors.house.product], { pay: true });
  assert.equal((await call('DELETE', `/admin/orders/${number}`, { token: admin })).status, 409);
  assert.equal((await call('DELETE', `/orders/${number}`, { token: ada })).status, 409);
});

test('the admin can cancel a whole order that is on its way, but not one already delivered', async () => {
  const { order: o, number } = await order([vendors.amara.product, vendors.bola.product], { pay: true });
  for (const key of ['amara', 'bola']) {
    const s = await shipmentOf(o, key);
    for (const st of ['confirmed', 'packed']) await vendorStep(key, s, st);
    await adminStep(s, 'shipped');
  }
  assert.equal((await call('POST', `/admin/orders/${number}/cancel`, { token: ada, body: { reason: 'x' } })).status, 403);
  assert.equal((await call('POST', `/admin/orders/${number}/cancel`, { token: admin, body: {} })).status, 400);
  const cancelled = await call('POST', `/admin/orders/${number}/cancel`, { token: admin, body: { reason: 'The customer refused it' } });
  assert.equal(cancelled.status, 200);
  const fresh = await Order.findById(o._id);
  assert.equal(fresh.cancelledBy, 'admin');
  assert.equal(fresh.refund.status, 'due');
  assert.equal((await call('POST', `/admin/orders/${number}/cancel`, { token: admin, body: { reason: 'again' } })).status, 409);

  // One that is delivered cannot be cancelled as a whole.
  const second = await order([vendors.amara.product, vendors.bola.product], { pay: true });
  const first = await shipmentOf(second.order, 'amara');
  for (const st of ['confirmed', 'packed', 'shipped', 'delivered']) await adminStep(first, st);
  const refused = await call('POST', `/admin/orders/${second.number}/cancel`, { token: admin, body: { reason: 'Mistake' } });
  assert.equal(refused.status, 409);
  assert.match(refused.data.message, /already delivered/);
});

test('every product is checked before it goes live unless the admin changes that', async () => {
  // A fresh store starts with checking turned on for every product.
  const { DEFAULTS } = require('../src/services/storeSettings');
  assert.equal(DEFAULTS.listingReviewMode, 'all');
});
