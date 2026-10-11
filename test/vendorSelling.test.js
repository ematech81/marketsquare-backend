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

let mongod;
let server;
let base;
let admin;
let ada; // a customer
let zara; // vendor 1
let tunde; // vendor 2
let zaraVendor;
let tundeVendor;
let category;
let zaraProduct;
const outbox = [];

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
const image = { url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' };
const wait = async () => {
  await new Promise((r) => setTimeout(r, 80));
  await mailer.idle();
};

async function becomeVendor(name, email, phone, business) {
  const token = (await call('POST', '/auth/register', { body: { name, email, phone, password: 'password123' } })).data.token;
  const apply = await call('POST', '/vendors/apply', {
    token,
    body: { businessName: business, category: 'Fashion', state: 'Lagos', city: 'Ikeja', phone, idType: 'nin', idNumber: '12345678901', bank: { bankName: 'GTBank', accountNumber: '0123456789', accountName: name } },
  });
  await call('PATCH', `/admin/vendors/${apply.data.vendor._id}/status`, { token: admin, body: { status: 'approved' } });
  // Sign in again so the token reflects the vendor role.
  const fresh = (await call('POST', '/auth/login', { body: { email, password: 'password123' } })).data.token;
  return { token: fresh, vendorId: apply.data.vendor._id };
}

const productBody = (title, price, extra = {}) => ({
  title, description: `${title} description text`, category: category._id, price, stock: 10, images: [image], status: 'active', ...extra,
});

// Buys one product through the real checkout and webhook, and returns the order number.
async function buy(productId, quantity = 1) {
  await call('POST', '/cart/items', { token: ada, body: { productId, quantity } });
  const res = await call('POST', '/orders/checkout', { token: ada, body: { address } });
  const order = await Order.findOne({ orderNumber: res.data.orderNumber });
  const data = { reference: order.checkoutReference, status: 'success', amount: order.total, currency: 'NGN' };
  await call('POST', '/webhooks/korapay', { body: { event: 'charge.success', data }, headers: { 'x-korapay-signature': sign(data) } });
  return res.data.orderNumber;
}

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  korapay.initializeCharge = async (a) => ({ checkout_url: `https://checkout.korapay.com/${a.reference}/pay` });
  mailer.setTransport({ sendMail: async (m) => outbox.push(m) });

  await User.create({ name: 'Admin', email: 'admin@example.com', phone: '08000000000', passwordHash: await bcrypt.hash('adminpass123', 4), role: 'admin' });
  admin = (await call('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'adminpass123' } })).data.token;
  ada = (await call('POST', '/auth/register', { body: { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'password123' } })).data.token;
  await call('PUT', '/admin/delivery-zones', { token: admin, body: { zones: [{ state: 'Lagos', fee: 2500, estimatedDays: 2 }] } });
  category = (await call('POST', '/admin/categories', { token: admin, body: { name: 'Fashion' } })).data.category;

  ({ token: zara, vendorId: zaraVendor } = await becomeVendor('Zara A', 'zara@example.com', '08011110001', 'Zara Wears'));
  ({ token: tunde, vendorId: tundeVendor } = await becomeVendor('Tunde B', 'tunde@example.com', '08011110002', 'Tunde Tech'));
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('store rules start with sensible defaults and only the admin can change them', async () => {
  assert.equal((await call('GET', '/admin/settings', { token: zara })).status, 403);
  const res = await call('GET', '/admin/settings', { token: admin });
  assert.deepEqual(res.data.settings, { defaultCommissionRate: 10, minPayoutAmount: 10000, requireListingApproval: true });
  assert.equal((await call('PUT', '/admin/settings', { token: admin, body: { defaultCommissionRate: 150, minPayoutAmount: 5000, requireListingApproval: true } })).status, 400);
});

test('a vendor lists a product, it waits for review, and goes live once approved', async () => {
  assert.equal((await call('GET', '/vendor/products', { token: ada })).status, 403); // customers cannot use vendor tools

  const created = await call('POST', '/vendor/products', { token: zara, body: productBody('Ankara Gown', 40000) });
  assert.equal(created.status, 201);
  assert.equal(created.data.product.status, 'pending');
  zaraProduct = created.data.product;
  assert.equal(String(zaraProduct.vendor), String(zaraVendor));

  // Not visible to shoppers yet.
  assert.equal((await call('GET', `/products/${zaraProduct.slug}`)).status, 404);
  assert.equal((await call('GET', '/admin/products?status=pending', { token: admin })).data.products[0].vendor.businessName, 'Zara Wears');

  // The admin turns it down once, with a reason, and the vendor is emailed.
  assert.equal((await call('PATCH', `/admin/products/${zaraProduct._id}/review`, { token: admin, body: { decision: 'reject' } })).status, 400);
  await call('PATCH', `/admin/products/${zaraProduct._id}/review`, { token: admin, body: { decision: 'reject', reason: 'Photo is blurry' } });
  await wait();
  assert.match(outbox.filter((m) => m.to === 'zara@example.com').at(-1).text, /Photo is blurry/);
  assert.equal((await call('GET', '/vendor/products/' + zaraProduct._id, { token: zara })).data.product.rejectionReason, 'Photo is blurry');

  // The vendor fixes it and publishes again, then the admin approves.
  const fixed = await call('PUT', `/vendor/products/${zaraProduct._id}`, { token: zara, body: productBody('Ankara Gown', 40000) });
  assert.equal(fixed.data.product.status, 'pending');
  await call('PATCH', `/admin/products/${zaraProduct._id}/review`, { token: admin, body: { decision: 'approve' } });
  assert.equal((await call('GET', `/products/${zaraProduct.slug}`)).status, 200);
  assert.equal((await call('GET', `/products/${zaraProduct.slug}`)).data.product.seller.name, 'Zara Wears');
});

test('editing a live product: price and stock stay live, but new text or photos go back to review', async () => {
  const priceOnly = await call('PUT', `/vendor/products/${zaraProduct._id}`, { token: zara, body: productBody('Ankara Gown', 42000, { stock: 7 }) });
  assert.equal(priceOnly.data.product.status, 'active');

  const retitled = await call('PUT', `/vendor/products/${zaraProduct._id}`, { token: zara, body: productBody('Ankara Gown Deluxe', 42000) });
  assert.equal(retitled.data.product.status, 'pending');
  await call('PATCH', `/admin/products/${zaraProduct._id}/review`, { token: admin, body: { decision: 'approve' } });

  // Vendors only touch their own products.
  assert.equal((await call('GET', `/vendor/products/${zaraProduct._id}`, { token: tunde })).status, 404);
  assert.equal((await call('PUT', `/vendor/products/${zaraProduct._id}`, { token: tunde, body: productBody('Stolen', 1000) })).status, 404);
  assert.equal((await call('DELETE', `/vendor/products/${zaraProduct._id}`, { token: tunde })).status, 404);
});

test('with approval switched off, a vendor publishes straight away', async () => {
  await call('PUT', '/admin/settings', { token: admin, body: { defaultCommissionRate: 10, minPayoutAmount: 10000, requireListingApproval: false } });
  const res = await call('POST', '/vendor/products', { token: tunde, body: productBody('Phone Case', 45000) });
  assert.equal(res.data.product.status, 'active');
  await call('PUT', '/admin/settings', { token: admin, body: { defaultCommissionRate: 10, minPayoutAmount: 10000, requireListingApproval: true } });

  const draft = await call('POST', '/vendor/products', { token: tunde, body: productBody('Secret Draft', 9000, { status: 'draft' }) });
  assert.equal(draft.data.product.status, 'draft');
});

test('public store pages list approved vendors with live products, and filter the catalog', async () => {
  const stores = await call('GET', '/stores');
  assert.deepEqual(stores.data.stores.map((s) => s.name).sort(), ['Tunde Tech', 'Zara Wears']);
  assert.equal(stores.data.stores[0].phone, undefined); // nothing private
  assert.equal(stores.data.stores[0].bank, undefined);

  assert.equal((await call('GET', `/stores/${zaraVendor}`)).data.store.productCount, 1);
  assert.equal((await call('GET', '/stores/not-an-id')).status, 404);

  const zaraOnly = await call('GET', `/products?vendor=${zaraVendor}`);
  assert.equal(zaraOnly.data.total, 1);
  assert.equal(zaraOnly.data.products[0].title, 'Ankara Gown Deluxe');
  assert.equal((await call('GET', '/products?vendor=house')).data.total, 0);
});

test('a paid order alerts the vendor, who confirms, packs and ships but cannot mark it delivered', async () => {
  const orderNumber = await buy(zaraProduct._id, 1);
  await wait();
  assert.match(outbox.filter((m) => m.to === 'zara@example.com').at(-1).subject, new RegExp(`New order ${orderNumber}`));

  const mine = await call('GET', '/vendor/orders?filter=open', { token: zara });
  assert.equal(mine.data.shipments.length, 1);
  assert.equal(mine.data.counts.toConfirm, 1);
  assert.equal(mine.data.shipments[0].address.street, '12 Allen Avenue');
  const id = mine.data.shipments[0].id;

  // Another vendor sees nothing of it.
  assert.equal((await call('GET', '/vendor/orders', { token: tunde })).data.shipments.length, 0);
  assert.equal((await call('PATCH', `/vendor/shipments/${id}/status`, { token: tunde, body: { status: 'confirmed' } })).status, 404);

  for (const status of ['confirmed', 'packed', 'shipped']) {
    assert.equal((await call('PATCH', `/vendor/shipments/${id}/status`, { token: zara, body: { status } })).status, 200);
  }
  assert.equal((await call('PATCH', `/vendor/shipments/${id}/status`, { token: zara, body: { status: 'delivered' } })).status, 400); // not allowed by the schema
  assert.equal((await call('PATCH', `/vendor/shipments/${id}/status`, { token: zara, body: { status: 'cancelled' } })).status, 409); // already on its way
  assert.equal((await call('GET', '/vendor/wallet', { token: zara })).data.balance, 0); // nothing paid before delivery

  // The admin marks it delivered: the vendor earns 42,000 minus 10% commission.
  await call('PATCH', `/admin/shipments/${id}/status`, { token: admin, body: { status: 'delivered' } });
  // A repeat cannot credit twice.
  await call('PATCH', `/admin/shipments/${id}/status`, { token: admin, body: { status: 'delivered' } });
  const wallet = await call('GET', '/vendor/wallet', { token: zara });
  assert.equal(wallet.data.balance, 37800);
  assert.deepEqual(wallet.data.transactions.map((t) => [t.type, t.amount]).sort(), [['commission', -4200], ['sale', 42000]]);
});

test('a vendor with their own commission rate earns on that rate', async () => {
  const phone = (await call('GET', '/products?vendor=' + tundeVendor)).data.products.find((p) => p.title === 'Phone Case');
  assert.equal((await call('PATCH', `/admin/vendors/${tundeVendor}/commission`, { token: admin, body: { commissionRate: 5 } })).status, 200);

  await buy(phone.id, 1);
  const shipment = (await call('GET', '/vendor/orders', { token: tunde })).data.shipments[0];
  for (const status of ['confirmed', 'packed', 'shipped', 'delivered']) {
    await call('PATCH', `/admin/shipments/${shipment.id}/status`, { token: admin, body: { status } });
  }
  assert.equal((await call('GET', '/vendor/wallet', { token: tunde })).data.balance, 42750); // 45,000 less 5%
});

test('payouts: minimum, balance check, paid, rejected and returned to the wallet', async () => {
  assert.equal((await call('POST', '/vendor/payouts', { token: zara, body: { amount: 5000 } })).status, 400); // below the minimum
  assert.equal((await call('POST', '/vendor/payouts', { token: zara, body: { amount: 99999 } })).status, 409); // more than the wallet holds

  const ask = await call('POST', '/vendor/payouts', { token: zara, body: { amount: 30000 } });
  assert.equal(ask.status, 201);
  assert.equal(ask.data.balance, 7800);
  assert.equal(ask.data.payout.bank.bankName, 'GTBank');
  const payoutId = ask.data.payout._id;

  assert.equal((await call('PATCH', `/admin/payouts/${payoutId}`, { token: zara, body: { status: 'paid' } })).status, 403);
  assert.equal((await call('PATCH', `/admin/payouts/${payoutId}`, { token: admin, body: { status: 'rejected' } })).status, 400); // needs a reason

  await call('PATCH', `/admin/payouts/${payoutId}`, { token: admin, body: { status: 'rejected', reason: 'Bank details look wrong' } });
  assert.equal((await call('GET', '/vendor/wallet', { token: zara })).data.balance, 37800); // money came back
  // It cannot be decided twice.
  assert.equal((await call('PATCH', `/admin/payouts/${payoutId}`, { token: admin, body: { status: 'paid' } })).status, 409);

  const again = await call('POST', '/vendor/payouts', { token: zara, body: { amount: 20000 } });
  await call('PATCH', `/admin/payouts/${again.data.payout._id}`, { token: admin, body: { status: 'paid', reference: 'BANK-123' } });
  await wait();
  const wallet = await call('GET', '/vendor/wallet', { token: zara });
  assert.equal(wallet.data.balance, 17800);
  assert.equal(wallet.data.payouts.find((p) => p.status === 'paid').reference, 'BANK-123');
  assert.match(outbox.filter((m) => m.to === 'zara@example.com').at(-1).text, /BANK-123/);

  const list = await call('GET', '/admin/payouts?status=paid', { token: admin });
  assert.equal(list.data.payouts[0].vendor.businessName, 'Zara Wears');
});

test('a vendor cancelling before shipping puts stock back and the admin is told to refund', async () => {
  process.env.ADMIN_ALERT_EMAIL = 'owner@example.com';
  const before = (await Product.findById(zaraProduct._id)).stock;
  const orderNumber = await buy(zaraProduct._id, 2);
  assert.equal((await Product.findById(zaraProduct._id)).stock, before - 2);

  const shipment = (await call('GET', '/vendor/orders?filter=open', { token: zara })).data.shipments.find((s) => s.orderNumber === orderNumber);
  assert.equal((await call('PATCH', `/vendor/shipments/${shipment.id}/status`, { token: zara, body: { status: 'cancelled' } })).status, 200);
  await wait();
  assert.equal((await Product.findById(zaraProduct._id)).stock, before);
  assert.match(outbox.filter((m) => m.to === 'owner@example.com').at(-1).text, /refund the customer/);
  process.env.ADMIN_ALERT_EMAIL = '';
});

test('after a return, the admin can take the vendor credit back once', async () => {
  const delivered = (await call('GET', '/vendor/orders?filter=done', { token: zara })).data.shipments.find((s) => s.status === 'delivered');
  const before = (await call('GET', '/vendor/wallet', { token: zara })).data.balance;

  const res = await call('POST', `/admin/shipments/${delivered.id}/reverse-credit`, { token: admin });
  assert.equal(res.status, 200);
  assert.equal(res.data.takenBack, 37800);
  assert.equal((await call('GET', '/vendor/wallet', { token: zara })).data.balance, before - 37800);
  assert.equal((await call('POST', `/admin/shipments/${delivered.id}/reverse-credit`, { token: admin })).status, 409); // only once
  assert.equal((await call('POST', `/admin/shipments/${delivered.id}/reverse-credit`, { token: zara })).status, 403);
});

test('the vendor overview adds up their shop', async () => {
  const res = await call('GET', '/vendor/overview', { token: tunde });
  assert.equal(res.data.businessName, 'Tunde Tech');
  assert.equal(res.data.balance, 42750);
  assert.equal(res.data.products.live, 1);
  assert.equal(res.data.products.draft, 1);
});
