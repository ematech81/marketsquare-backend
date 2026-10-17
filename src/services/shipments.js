const crypto = require('crypto');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const HttpError = require('../utils/httpError');
const notify = require('./notify');
const wallet = require('./wallet');
const Shipment = require('../models/Shipment');
const { progressOf } = require('./orderProgress');
const { settleCodOrder } = require('./orders');

const FLOW = ['placed', 'confirmed', 'packed', 'shipped', 'delivered'];
const MAX_CODE_TRIES = 5;

const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const sameCode = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Moves one shipment forward a step, or cancels it. Used by the admin, by vendors and by customers.
// `allowed` is the list of statuses the caller may set. `opts.by` says who is asking:
//   - 'admin': may do anything.
//   - 'vendor': may confirm, pack and ship. For a shipment the vendor delivers themselves they must give the courier's
//     details when shipping, and the customer's 6-digit code to mark it delivered.
//   - 'customer': may mark their own shipment delivered once it has shipped ("I received my order").
async function moveShipment(shipment, status, allowed, opts = {}) {
  const by = opts.by ?? 'admin';
  if (!allowed.includes(status)) throw new HttpError(403, `You cannot mark a shipment as ${status}`);
  if (shipment.status === 'delivered' || shipment.status === 'cancelled') {
    throw new HttpError(409, `This shipment is already ${shipment.status}`);
  }

  if (status === 'cancelled') {
    // Put the stock back, once, for the lines whose stock was taken at payment.
    for (const item of shipment.items) {
      if (item.stockTaken) {
        await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } });
        item.stockTaken = false;
      }
    }
  } else if (FLOW.indexOf(status) !== FLOW.indexOf(shipment.status) + 1) {
    throw new HttpError(409, `A ${shipment.status} shipment cannot go straight to ${status}. Do each step in order`);
  }

  const selfDelivered = shipment.fulfilledBy === 'vendor';
  // Where the whole order stands before this change, so the customer is told only when the ORDER moves on.
  const before = progressOf(await Shipment.find({ order: shipment.order }));

  if (status === 'shipped' && selfDelivered) {
    // The vendor says who is carrying it, so the customer and Square Market know. The code proves it arrived.
    const courierName = String(opts.delivery?.courierName ?? '').trim();
    if (by === 'vendor' && courierName.length < 2) throw new HttpError(400, 'courierName: Enter who is delivering it (the rider, driver or courier company)');
    shipment.delivery = {
      courierName: courierName || undefined,
      courierPhone: String(opts.delivery?.courierPhone ?? '').trim() || undefined,
      note: String(opts.delivery?.note ?? '').trim().slice(0, 300) || undefined,
      shippedAt: new Date(),
    };
    shipment.deliveryCode = newCode();
    shipment.codeAttempts = 0;
  }

  if (status === 'delivered') {
    if (by === 'vendor') {
      if (!selfDelivered) throw new HttpError(403, 'Square Market delivers this order, so only Square Market can mark it delivered');
      if (shipment.codeAttempts >= MAX_CODE_TRIES) {
        throw new HttpError(429, 'Too many wrong codes. Ask the customer to tap "I received my order", or contact Square Market');
      }
      if (!opts.code || !shipment.deliveryCode || !sameCode(opts.code, shipment.deliveryCode)) {
        shipment.codeAttempts += 1;
        await shipment.save();
        throw new HttpError(400, 'code: That code is not right. Ask the customer for the 6-digit code from their order page');
      }
      shipment.deliveredBy = 'code';
    } else if (by === 'customer') {
      shipment.deliveredBy = 'customer';
    } else {
      shipment.deliveredBy = 'admin';
    }
  }

  shipment.status = status;
  shipment.timeline.push({ status, at: new Date() });
  await shipment.save();

  // A delivered shipment pays the vendor (into their pending balance, which is released after the protection period).
  if (status === 'delivered') {
    await wallet.creditForDelivery(shipment);
    // Pay on delivery: when the last shipment is delivered, the money has been collected.
    await settleCodOrder(shipment.order);
  }

  // `silent` is used when a whole order is cancelled: the customer gets one message for it, not one per package.
  if (!opts.silent && ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled'].includes(status)) {
    const order = await Order.findById(shipment.order);
    const user = order && (await User.findById(order.user));
    const after = progressOf(await Shipment.find({ order: shipment.order }));
    if (order && user) notify.orderProgressed(order, user, { before, after, shipment });
  }
  return shipment;
}

module.exports = { moveShipment, FLOW, MAX_CODE_TRIES };
