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
let category;
let zara; // a vendor who delivers their own orders
let zaraVendor;
let tunde; // a vendor Square Market delivers for
let tundeVendor;
let zaraProduct;
let tundeProduct;

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
const DAY = 86400000;

async function makeVendor(name, email, phone) {
  const user = await User.create({ name, email, phone, passwordHash: await bcrypt.hash('password123', 4), role: 'vendor' });
  const vendor = await Vendor.create({
    user: user._id,
    businessName: `${name} Shop`,
    category: 'Gadget',
    state: 'FCT (Abuja)',
    city: 'Wuse',
    phone,
    idType: 'nin',
    idNumber: '12345678901',
    bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: name },
    status: 'approved',
  });
  const token = (await call('POST', '/auth/login', { body: { email, password: 'password123' } })).data.token;
  return { token, vendor };
}

// Buys one product online through the real checkout and the KoraPay webhook. Returns the order and its shipment.
async function buy(product, state = 'Lagos') {
  await Cart.deleteMany({});
  await call('POST', '/cart/items', { token: ada, body: { productId: product._id, quantity: 1 } });
  const res = await call('POST', '/orders/checkout', { token: ada, body: { address: { ...address, state } } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const order = await Order.findOne({ orderNumber: res.data.orderNumber });
  const data = { reference: order.checkoutReference, status: 'success', amount: order.total, currency: 'NGN' };
  await call('POST', '/webhooks/korapay', { body: { event: 'charge.success', data }, headers: { 'x-korapay-signature': sign(data) } });
  return { order, shipment: await Shipment.findOne({ order: order._id }) };
}

const vendorStep = (token, shipment, body) => call('PATCH', `/vendor/shipments/${shipment._id}/status`, { token, body });
const fullFlowToShipped = async (token, shipment) => {
  for (const status of ['confirmed', 'packed']) assert.equal((await vendorStep(token, shipment, { status })).status, 200);
  return vendorStep(token, shipment, { status: 'shipped', courierName: 'Musa Bello (rider)', courierPhone: '08099998888' });
};

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
  // Square Market delivers to Lagos only, for 2,000.
  await call('PUT', '/admin/delivery-zones', { token: admin, body: { zones: [{ state: 'Lagos', fee: 2000, estimatedDays: 2 }] } });

  category = await Category.create({ name: 'Gadget', slug: 'gadget' });
  ({ token: zara, vendor: zaraVendor } = await makeVendor('Zara', 'zara@example.com', '08011110001'));
  ({ token: tunde, vendor: tundeVendor } = await makeVendor('Tunde', 'tunde@example.com', '08011110002'));
  const common = { description: 'A good product to buy', category: category._id, images: [{ url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' }], status: 'active', stock: 50 };
  zaraProduct = await Product.create({ ...common, title: 'Zara Laptop', slug: 'zara-laptop', price: 50000, vendor: zaraVendor._id });
  tundeProduct = await Product.create({ ...common, title: 'Tunde Phone', slug: 'tunde-phone', price: 40000, vendor: tundeVendor._id });
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('a vendor chooses to deliver themselves and sets a fee for each state they serve', async () => {
  const start = await call('GET', '/vendor/delivery', { token: zara });
  assert.equal(start.data.mode, 'platform'); // Square Market delivers until the vendor chooses otherwise

  const put = (body) => call('PUT', '/vendor/delivery', { token: zara, body });
  assert.equal((await put({ mode: 'self', rates: [] })).status, 400); // needs at least one state
  assert.equal((await put({ mode: 'self', rates: [{ state: 'FCT (Abuja)', fee: 3000 }, { state: 'FCT (Abuja)', fee: 4000 }] })).status, 400); // a state twice
  assert.equal((await put({ mode: 'self', rates: [{ state: 'Narnia', fee: 3000 }] })).status, 400);
  assert.equal((await call('PUT', '/vendor/delivery', { token: ada, body: { mode: 'self', rates: [{ state: 'FCT (Abuja)', fee: 1 }] } })).status, 403); // customers cannot

  const ok = await put({ mode: 'self', rates: [{ state: 'FCT (Abuja)', fee: 3500, estimatedDays: 2 }, { state: 'Lagos', fee: 5000, estimatedDays: 4 }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.mode, 'self');
  assert.equal(ok.data.rates.length, 2);
});

test('the product page and checkout use the vendor\'s own fee, and a state they do not serve is refused', async () => {
  const lagos = (await call('GET', `/delivery-quote?state=Lagos&vendor=${zaraVendor._id}`)).data;
  assert.deepEqual([lagos.available, lagos.mode, lagos.fee, lagos.estimatedDays], [true, 'vendor', 5000, 4]);
  // Another vendor, and the store's own products, use Square Market's fee.
  assert.equal((await call('GET', `/delivery-quote?state=Lagos&vendor=${tundeVendor._id}`)).data.fee, 2000);
  assert.equal((await call('GET', '/delivery-quote?state=Lagos')).data.mode, 'platform');
  assert.equal((await call('GET', `/delivery-quote?state=Kano&vendor=${zaraVendor._id}`)).data.available, false);

  await Cart.deleteMany({});
  await call('POST', '/cart/items', { token: ada, body: { productId: zaraProduct._id, quantity: 1 } });
  await call('POST', '/cart/items', { token: ada, body: { productId: tundeProduct._id, quantity: 1 } });
  const quote = (await call('GET', '/orders/delivery-quote?state=Lagos', { token: ada })).data;
  assert.equal(quote.sellers.length, 2);
  assert.equal(quote.sellers.find((s) => s.name === 'Zara Shop').fee, 5000);
  assert.equal(quote.sellers.find((s) => s.name === 'Tunde Shop').fee, 2000);
  assert.equal(quote.codAllowed, false); // one seller delivers themselves

  // Abuja: Zara serves it, Square Market does not, so Tunde's items cannot be delivered there.
  const abuja = await call('POST', '/orders/checkout', { token: ada, body: { address: { ...address, state: 'FCT (Abuja)' } } });
  assert.equal(abuja.status, 400);
  assert.match(abuja.data.message, /Tunde Shop does not deliver to FCT \(Abuja\)/);
});

test('pay on delivery is refused when a vendor delivers themselves', async () => {
  await Cart.deleteMany({});
  await call('POST', '/cart/items', { token: ada, body: { productId: zaraProduct._id, quantity: 1 } });
  const cod = await call('POST', '/orders/checkout', { token: ada, body: { address, paymentMethod: 'cod' } });
  assert.equal(cod.status, 400);
  assert.match(cod.data.message, /vendor delivers themselves/);
});

test('shipping needs the courier, the customer gets a code, and only the right code delivers it', async () => {
  const { order, shipment } = await buy(zaraProduct);
  assert.equal(shipment.fulfilledBy, 'vendor');
  assert.equal(shipment.deliveryFee, 5000);
  assert.equal(order.deliveries[0].mode, 'vendor');

  for (const status of ['confirmed', 'packed']) assert.equal((await vendorStep(zara, shipment, { status })).status, 200);
  // The courier must be named.
  const noCourier = await vendorStep(zara, shipment, { status: 'shipped' });
  assert.equal(noCourier.status, 400);
  assert.match(noCourier.data.message, /courierName/);
  assert.equal((await vendorStep(zara, shipment, { status: 'shipped', courierName: 'Musa Bello (rider)', courierPhone: '08099998888' })).status, 200);

  // The customer can see the code; the vendor and the public cannot.
  const mine = (await call('GET', `/orders/${order.orderNumber}`, { token: ada })).data.order.shipments[0];
  assert.match(mine.deliveryCode, /^\d{6}$/);
  assert.equal(mine.delivery.courierName, 'Musa Bello (rider)');
  assert.equal(mine.earning, undefined); // what the vendor earns is not the customer's business
  const theirs = await call('GET', '/vendor/orders', { token: zara });
  assert.equal(JSON.stringify(theirs.data).includes(mine.deliveryCode), false);

  // Wrong codes are refused and counted; the vendor cannot guess.
  const wrong = mine.deliveryCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) {
    const r = await vendorStep(zara, shipment, { status: 'delivered', code: wrong });
    assert.equal(r.status, 400);
  }
  const locked = await vendorStep(zara, shipment, { status: 'delivered', code: mine.deliveryCode });
  assert.equal(locked.status, 429); // too many wrong tries; now the customer or Square Market must confirm
  assert.equal((await Shipment.findById(shipment._id)).status, 'shipped');
});

test('a correct code delivers it, and the earnings wait in "pending" for the protection period', async () => {
  const { order, shipment } = await buy(zaraProduct);
  assert.equal((await fullFlowToShipped(zara, shipment)).status, 200);
  const code = (await Shipment.findById(shipment._id)).deliveryCode;

  assert.equal((await vendorStep(zara, shipment, { status: 'delivered', code })).status, 200);
  const done = await Shipment.findById(shipment._id);
  assert.equal(done.status, 'delivered');
  assert.equal(done.deliveredBy, 'code');
  assert.equal((await Order.findById(order._id)).paymentStatus, 'paid');

  // 50,000 less 10% commission, plus the 5,000 delivery fee the vendor delivered for.
  assert.deepEqual([done.earning.gross, done.earning.commission, done.earning.deliveryFee, done.earning.net], [50000, 5000, 5000, 50000]);
  const wallet = (await call('GET', '/vendor/wallet', { token: zara })).data;
  assert.equal(wallet.pending, 50000 + (await Vendor.findById(zaraVendor._id)).pendingBalance - 50000);
  assert.ok(wallet.pending >= 50000);
  assert.equal(wallet.balance, 0); // nothing can be paid out yet
  assert.equal(wallet.waiting.length >= 1, true);

  // A new vendor waits 7 + 7 days.
  const days = Math.round((done.earning.releaseAt - done.earning.creditedAt) / DAY);
  assert.equal(days, 14);

  // The vendor cannot take it out early.
  const early = await call('POST', '/vendor/payouts', { token: zara, body: { amount: 10000 } });
  assert.equal(early.status, 409);
});

test('when the protection period is over the money becomes available, once', async () => {
  const before = (await call('GET', '/vendor/wallet', { token: zara })).data;
  assert.equal(before.balance, 0);

  // Pretend the waiting time has passed.
  await Shipment.updateMany({ vendor: zaraVendor._id, 'earning.net': { $exists: true } }, { $set: { 'earning.releaseAt': new Date(Date.now() - 1000) } });
  const after = (await call('GET', '/vendor/wallet', { token: zara })).data;
  assert.equal(after.pending, 0);
  assert.equal(after.balance, before.pending);
  // Opening the wallet again releases nothing more.
  assert.equal((await call('GET', '/vendor/wallet', { token: zara })).data.balance, before.pending);

  const payout = await call('POST', '/vendor/payouts', { token: zara, body: { amount: 10000 } });
  assert.equal(payout.status, 201);
});

test('the customer can confirm delivery themselves, and nobody else can', async () => {
  const { order, shipment } = await buy(zaraProduct);
  assert.equal((await fullFlowToShipped(zara, shipment)).status, 200);
  const url = `/orders/${order.orderNumber}/shipments/${shipment._id}/confirm-delivery`;

  const other = (await call('POST', '/auth/register', { body: { name: 'Eve', email: 'eve@example.com', phone: '08035556666', password: 'password123' } })).data.token;
  assert.equal((await call('POST', url, { token: other })).status, 404); // not their order
  assert.equal((await call('POST', url)).status, 401);

  const res = await call('POST', url, { token: ada });
  assert.equal(res.status, 200);
  const done = await Shipment.findById(shipment._id);
  assert.equal(done.status, 'delivered');
  assert.equal(done.deliveredBy, 'customer');
  assert.ok(done.earning.net > 0);
  // It cannot be confirmed twice.
  assert.equal((await call('POST', url, { token: ada })).status, 409);
});

test('a customer problem holds the vendor\'s money until Square Market decides', async () => {
  const { order, shipment } = await buy(zaraProduct);
  assert.equal((await fullFlowToShipped(zara, shipment)).status, 200);
  const reportUrl = `/orders/${order.orderNumber}/shipments/${shipment._id}/report`;

  assert.equal((await call('POST', reportUrl, { token: ada, body: { reason: 'short' } })).status, 400);
  assert.equal((await call('POST', reportUrl, { token: zara, body: { reason: 'The customer is lying about this' } })).status, 404); // not their order
  assert.equal((await call('POST', reportUrl, { token: ada, body: { reason: 'The rider has not arrived and is not answering' } })).status, 200);
  assert.equal((await call('POST', reportUrl, { token: ada, body: { reason: 'The rider has not arrived and is not answering' } })).status, 409); // only once

  // The vendor cannot deliver it while it is under review; the customer cannot confirm it either.
  const code = (await Shipment.findById(shipment._id)).deliveryCode;
  assert.equal((await vendorStep(zara, shipment, { status: 'delivered', code })).status, 409);
  assert.equal((await call('POST', `/orders/${order.orderNumber}/shipments/${shipment._id}/confirm-delivery`, { token: ada })).status, 409);

  // The admin delivers it after checking, and the money stays on hold because the problem is still open.
  assert.equal((await call('PATCH', `/admin/shipments/${shipment._id}/status`, { token: admin, body: { status: 'delivered' } })).status, 200);
  await Shipment.updateOne({ _id: shipment._id }, { $set: { 'earning.releaseAt': new Date(Date.now() - 1000) } });
  const walletBefore = (await call('GET', '/vendor/wallet', { token: zara })).data;
  assert.equal(walletBefore.waiting.find((w) => w.orderNumber === order.orderNumber).onHold, true);
  assert.equal((await Shipment.findById(shipment._id)).earning.releasedAt, undefined);

  // The admin decides in the vendor's favour: released.
  const resolved = await call('POST', `/admin/shipments/${shipment._id}/dispute`, { token: admin, body: { resolution: 'release', note: 'Delivered, the customer confirmed by phone' } });
  assert.equal(resolved.status, 200);
  assert.ok((await Shipment.findById(shipment._id)).earning.releasedAt);
  assert.equal((await call('POST', `/admin/shipments/${shipment._id}/dispute`, { token: admin, body: { resolution: 'release' } })).status, 409); // already settled
});

test('a problem decided for the customer takes the vendor\'s earnings back', async () => {
  const { order, shipment } = await buy(zaraProduct);
  assert.equal((await fullFlowToShipped(zara, shipment)).status, 200);
  await call('POST', `/orders/${order.orderNumber}/shipments/${shipment._id}/report`, { token: ada, body: { reason: 'The box was empty when it arrived' } });
  assert.equal((await call('PATCH', `/admin/shipments/${shipment._id}/status`, { token: admin, body: { status: 'delivered' } })).status, 200);

  const pendingBefore = (await Vendor.findById(zaraVendor._id)).pendingBalance;
  const refunded = await call('POST', `/admin/shipments/${shipment._id}/dispute`, { token: admin, body: { resolution: 'refund' } });
  assert.equal(refunded.status, 200);
  assert.equal(refunded.data.takenBack, 50000);
  assert.equal((await Vendor.findById(zaraVendor._id)).pendingBalance, pendingBefore - 50000);
  // It can never be released afterwards.
  await Shipment.updateOne({ _id: shipment._id }, { $set: { 'earning.releaseAt': new Date(Date.now() - 1000) } });
  await call('GET', '/vendor/wallet', { token: zara });
  assert.equal((await Shipment.findById(shipment._id)).earning.releasedAt, undefined);
});

test('after the money is released, a customer can no longer open a problem (they contact support)', async () => {
  const { order, shipment } = await buy(zaraProduct);
  assert.equal((await fullFlowToShipped(zara, shipment)).status, 200);
  assert.equal((await call('PATCH', `/admin/shipments/${shipment._id}/status`, { token: admin, body: { status: 'delivered' } })).status, 200);
  await Shipment.updateOne({ _id: shipment._id }, { $set: { 'earning.releaseAt': new Date(Date.now() - 1000) } });
  await call('GET', '/vendor/wallet', { token: zara });
  const late = await call('POST', `/orders/${order.orderNumber}/shipments/${shipment._id}/report`, { token: ada, body: { reason: 'It stopped working after a month' } });
  assert.equal(late.status, 409);
  assert.match(late.data.message, /protection period/);
});

test('Square Market delivering for a vendor: the vendor cannot deliver, there is no code, and no delivery fee goes to them', async () => {
  const { shipment } = await buy(tundeProduct);
  assert.equal(shipment.fulfilledBy, 'platform');
  for (const status of ['confirmed', 'packed']) assert.equal((await vendorStep(tunde, shipment, { status })).status, 200);
  // The vendor says it is ready; Square Market ships it.
  assert.equal((await vendorStep(tunde, shipment, { status: 'shipped' })).status, 403);
  assert.equal((await call('PATCH', `/admin/shipments/${shipment._id}/status`, { token: admin, body: { status: 'shipped' } })).status, 200);
  assert.equal((await Shipment.findById(shipment._id)).deliveryCode, undefined);
  assert.equal((await vendorStep(tunde, shipment, { status: 'delivered', code: '123456' })).status, 403);

  assert.equal((await call('PATCH', `/admin/shipments/${shipment._id}/status`, { token: admin, body: { status: 'delivered' } })).status, 200);
  const done = await Shipment.findById(shipment._id);
  assert.equal(done.deliveredBy, 'admin');
  assert.equal(done.earning.deliveryFee, 0); // Square Market delivered, so it keeps the delivery fee
  assert.equal(done.earning.net, 36000); // 40,000 less 10%
});

test('the admin can stop a vendor from delivering their own orders', async () => {
  assert.equal((await call('PATCH', `/admin/vendors/${zaraVendor._id}/delivery`, { token: zara, body: { locked: true } })).status, 403);
  const locked = await call('PATCH', `/admin/vendors/${zaraVendor._id}/delivery`, { token: admin, body: { locked: true } });
  assert.equal(locked.status, 200);
  assert.equal(locked.data.vendor.deliveryMode, 'platform'); // Square Market delivers again
  const again = await call('PUT', '/vendor/delivery', { token: zara, body: { mode: 'self', rates: [{ state: 'Lagos', fee: 1000 }] } });
  assert.equal(again.status, 403);
  // New orders for them go back to Square Market's own fees.
  assert.equal((await call('GET', `/delivery-quote?state=Lagos&vendor=${zaraVendor._id}`)).data.mode, 'platform');
  await call('PATCH', `/admin/vendors/${zaraVendor._id}/delivery`, { token: admin, body: { locked: false } });
});

test('a vendor\'s later deliveries wait 7 days, not 14', async () => {
  // Zara has more than 3 delivered shipments by now.
  await call('PUT', '/vendor/delivery', { token: zara, body: { mode: 'self', rates: [{ state: 'Lagos', fee: 5000, estimatedDays: 4 }] } });
  const { shipment } = await buy(zaraProduct);
  assert.equal((await fullFlowToShipped(zara, shipment)).status, 200);
  const code = (await Shipment.findById(shipment._id)).deliveryCode;
  assert.equal((await vendorStep(zara, shipment, { status: 'delivered', code })).status, 200);
  const e = (await Shipment.findById(shipment._id)).earning;
  assert.equal(Math.round((e.releaseAt - e.creditedAt) / DAY), 7);
});

test('the admin sees the commission earned and what is owed to vendors', async () => {
  assert.equal((await call('GET', '/admin/earnings', { token: zara })).status, 403);
  const res = await call('GET', '/admin/earnings', { token: admin });
  assert.equal(res.status, 200);
  const e = res.data;
  assert.ok(e.commission.allTime > 0);
  assert.ok(e.commission.thisMonth > 0);
  assert.ok(e.sales.deliveredOrders >= 5);
  // The refunded shipment is not counted.
  const counted = await Shipment.aggregate([
    { $match: { 'earning.net': { $exists: true }, 'earning.reversedAt': { $exists: false } } },
    { $group: { _id: null, commission: { $sum: '$earning.commission' } } },
  ]);
  assert.equal(e.commission.allTime, counted[0].commission);
  const [vendors] = [await Vendor.find({}).select('pendingBalance walletBalance')];
  assert.equal(e.owed.pending, vendors.reduce((n, v) => n + v.pendingBalance, 0));
  assert.equal(e.owed.available, vendors.reduce((n, v) => n + v.walletBalance, 0));
  assert.ok(e.vendors.find((v) => v.name === 'Zara Shop'));
});

test('the settings control the waiting periods', async () => {
  const set = (body) => call('PUT', '/admin/settings', { token: admin, body: { defaultCommissionRate: 10, minPayoutAmount: 10000, requireListingApproval: false, ...body } });
  assert.equal((await set({ payoutHoldDays: -1 })).status, 400);
  assert.equal((await set({ payoutHoldDays: 90 })).status, 400);
  const ok = await set({ payoutHoldDays: 0, newVendorExtraHoldDays: 0 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settings.payoutHoldDays, 0);

  // With no waiting period the money is available the moment it is delivered.
  const { shipment } = await buy(tundeProduct);
  for (const status of ['confirmed', 'packed']) await vendorStep(tunde, shipment, { status });
  for (const status of ['shipped', 'delivered']) await call('PATCH', `/admin/shipments/${shipment._id}/status`, { token: admin, body: { status } });
  assert.ok((await Shipment.findById(shipment._id)).earning.releasedAt);
});
