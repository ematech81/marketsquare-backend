const Order = require('../models/Order');
const Product = require('../models/Product');
const Shipment = require('../models/Shipment');
const Cart = require('../models/Cart');
const User = require('../models/User');
const notify = require('./notify');

// Turns a pending order into a paid one. Safe to call any number of times for the same order
// (webhook retries, the customer's return page, a manual verify): only the first call that finds the
// order still pending does the work; every later call returns { alreadyProcessed: true }.
async function markOrderPaid(order, paidAmount) {
  const now = new Date();

  // KoraPay says it was paid, but not the amount we asked for. Don't ship; flag it for a person.
  if (Number(paidAmount) !== order.total) {
    const flagged = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: 'pending' },
      {
        paymentStatus: 'mismatch',
        paidAmount: Number(paidAmount),
        needsAttention: `Paid ${paidAmount} but the order total is ${order.total}`,
      },
      { new: true }
    );
    return { order: flagged ?? order, alreadyProcessed: !flagged, mismatch: true };
  }

  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: 'pending' },
    { paymentStatus: 'paid', paidAt: now, paidAmount: Number(paidAmount) },
    { new: true }
  );
  if (!claimed) return { order, alreadyProcessed: true };

  await fulfilOrder(claimed, now);

  return { order: claimed, alreadyProcessed: false };
}

// What happens once an order is real, whether it was paid online or placed as pay-on-delivery:
// take the stock, make one shipment per seller, empty those items from the cart and tell everyone.
async function fulfilOrder(claimed, now = new Date()) {
  // Take the stock. A product that sold out in the meantime is flagged, not silently oversold.
  const shortages = [];
  const taken = new Map();
  for (const [i, line] of claimed.items.entries()) {
    const res = await Product.updateOne({ _id: line.product, stock: { $gte: line.quantity } }, { $inc: { stock: -line.quantity } });
    taken.set(i, res.modifiedCount > 0);
    if (res.modifiedCount === 0) shortages.push(line.title);
  }
  if (shortages.length > 0) {
    claimed.needsAttention = `Not enough stock for: ${shortages.join(', ')}`;
    await claimed.save();
  }

  // One shipment per seller.
  const byVendor = new Map();
  for (const line of claimed.items) {
    const key = line.vendor ? String(line.vendor) : 'house';
    if (!byVendor.has(key)) byVendor.set(key, []);
    byVendor.get(key).push({ line, stockTaken: taken.get(claimed.items.indexOf(line)) });
  }
  for (const [key, lines] of byVendor) {
    const vendor = key === 'house' ? null : lines[0].line.vendor;
    const delivery = claimed.deliveries.find((d) => String(d.vendor ?? 'house') === key);
    const eta = delivery?.estimatedDays ? new Date(now.getTime() + delivery.estimatedDays * 86400000) : undefined;
    await Shipment.updateOne(
      { order: claimed._id, vendor },
      {
        $setOnInsert: {
          items: lines.map(({ line: l, stockTaken }) => ({
            product: l.product,
            title: l.title,
            image: l.image,
            price: l.price,
            quantity: l.quantity,
            options: l.options,
            stockTaken,
          })),
          deliveryFee: delivery?.fee ?? 0,
          status: 'placed',
          timeline: [{ status: 'placed', at: now }],
          estimatedDelivery: eta,
        },
      },
      { upsert: true }
    );
  }

  // The customer has paid for these, so take them out of their cart.
  await Cart.updateOne({ user: claimed.user }, { $pull: { items: { product: { $in: claimed.items.map((l) => l.product) } } } });

  // Emails go out in the background so the webhook can answer quickly. A mail problem never undoes the order.
  User.findById(claimed.user)
    .then((user) => {
      if (!user) return;
      if (claimed.paymentMethod === 'cod') notify.orderPlacedCod(claimed, user);
      else notify.orderPaid(claimed, user);
    })
    .catch((err) => console.error('Order email failed:', err.message));
}

// A pay-on-delivery order is real the moment it is placed: nothing is paid yet, but the items are reserved,
// the vendors are told to start packing, and the money is collected when it arrives.
async function placeCodOrder(order) {
  await fulfilOrder(order);
  return order;
}

// Pay on delivery: once every shipment that was not cancelled is delivered, the cash has been collected.
// The order becomes paid for what was actually delivered. Safe to call any number of times.
async function settleCodOrder(orderId) {
  const order = await Order.findById(orderId);
  if (!order || order.paymentMethod !== 'cod' || order.paymentStatus !== 'cod') return null;

  const shipments = await Shipment.find({ order: order._id });
  const live = shipments.filter((s) => s.status !== 'cancelled');
  if (live.length === 0 || !live.every((s) => s.status === 'delivered')) return null;

  const collected = live.reduce((sum, s) => sum + s.deliveryFee + s.items.reduce((n, i) => n + i.price * i.quantity, 0), 0);
  return Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: 'cod' },
    { paymentStatus: 'paid', paidAt: new Date(), paidAmount: collected },
    { new: true }
  );
}

module.exports = { markOrderPaid, placeCodOrder, settleCodOrder };
