const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const HttpError = require('../utils/httpError');
const notify = require('./notify');
const wallet = require('./wallet');
const { settleCodOrder } = require('./orders');

const FLOW = ['placed', 'confirmed', 'packed', 'shipped', 'delivered'];

// Moves one shipment forward a step, or cancels it. Used by the admin and by vendors.
// `allowed` is the list of statuses the caller may set.
async function moveShipment(shipment, status, allowed) {
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

  shipment.status = status;
  shipment.timeline.push({ status, at: new Date() });
  await shipment.save();

  // A delivered shipment pays the vendor.
  if (status === 'delivered') {
    await wallet.creditForDelivery(shipment);
    // Pay on delivery: when the last shipment is delivered, the money has been collected.
    await settleCodOrder(shipment.order);
  }

  if (['confirmed', 'packed', 'shipped', 'delivered', 'cancelled'].includes(status)) {
    const order = await Order.findById(shipment.order);
    const user = order && (await User.findById(order.user));
    if (order && user) notify.shipmentChanged(order, user, shipment);
  }
  return shipment;
}

module.exports = { moveShipment, FLOW };
