// One place that decides who is told what, by email and by SMS.
const Vendor = require('../models/Vendor');
const emails = require('./emails');
const { sendSms } = require('./sms');
const { notifyUser, notifyAdmins } = require('./notifications');

// In-app text can use the Naira sign.
const money = (n) => `₦${Number(n).toLocaleString('en-NG')}`;

// SMS text avoids the Naira sign and other special characters, which would split it into extra, pricier messages.
const SHIPMENT_SMS = {
  shipped: (n) => `Square Market: your order ${n} is on its way to you.`,
  delivered: (n) => `Square Market: your order ${n} has been delivered. Thank you for shopping with us!`,
  cancelled: (n) => `Square Market: part of your order ${n} was cancelled. We will contact you about your refund.`,
};

// Each vendor whose products were bought hears about it, so they can start packing.
async function alertVendors(order) {
  const ids = [...new Set(order.items.filter((i) => i.vendor).map((i) => String(i.vendor)))];
  if (ids.length === 0) return;
  const vendors = await Vendor.find({ _id: { $in: ids } }).populate('user', 'name email');
  for (const vendor of vendors) {
    if (!vendor.user) continue;
    const lines = order.items.filter((i) => String(i.vendor) === String(vendor._id));
    emails.vendorNewOrder(vendor, vendor.user, order, lines);
    notifyUser(vendor.user._id, {
      type: 'vendor_new_order',
      title: `New order ${order.orderNumber}`,
      body: `${lines.length} ${lines.length === 1 ? 'item' : 'items'} to confirm and pack${order.paymentMethod === 'cod' ? ' (pay on delivery)' : ''}.`,
      link: '/orders',
    });
    sendSms({ to: vendor.phone, message: `Square Market: new order ${order.orderNumber} for ${vendor.businessName}. Open your dashboard to confirm it.` });
  }
}

// Payment confirmed: receipt to the customer, alert to the owner, alert to each vendor involved.
function orderPaid(order, user) {
  notifyUser(user._id, { type: 'order_paid', title: 'Payment confirmed', body: `We received your payment for order ${order.orderNumber}.`, link: `/orders/${order.orderNumber}` });
  notifyAdmins({ type: 'admin_new_order', title: `New paid order ${order.orderNumber}`, body: `${money(order.total)}, ${order.address.state}.`, link: `/orders/${order.orderNumber}` });
  emails.orderReceived(order, user);
  emails.newOrderAlert(order, user);
  sendSms({ to: order.address.phone, message: `Square Market: we received your payment for order ${order.orderNumber}. We will deliver it to you soon.` });
  sendSms({
    to: process.env.ADMIN_ALERT_PHONE,
    message: `New paid order ${order.orderNumber}, ${order.total} Naira, ${order.address.state}.`,
  });
  alertVendors(order).catch((err) => console.error('Vendor alert failed:', err.message));
}

// Pay on delivery: the order is placed but not paid. Same people hear about it, with the right words.
function orderPlacedCod(order, user) {
  notifyUser(user._id, { type: 'order_placed', title: 'Order placed', body: `Order ${order.orderNumber} is placed. Pay ${money(order.total)} when it arrives.`, link: `/orders/${order.orderNumber}` });
  notifyAdmins({ type: 'admin_new_order', title: `New pay on delivery order ${order.orderNumber}`, body: `${money(order.total)}, ${order.address.state}.`, link: `/orders/${order.orderNumber}` });
  emails.orderReceived(order, user);
  emails.newOrderAlert(order, user);
  sendSms({ to: order.address.phone, message: `Square Market: we received your order ${order.orderNumber}. Please have ${order.total} Naira ready to pay when it arrives.` });
  sendSms({
    to: process.env.ADMIN_ALERT_PHONE,
    message: `New PAY ON DELIVERY order ${order.orderNumber}, ${order.total} Naira, ${order.address.state}.`,
  });
  alertVendors(order).catch((err) => console.error('Vendor alert failed:', err.message));
}

const SHIPMENT_NOTE = {
  confirmed: ['Order confirmed', 'We have confirmed your order and will pack it soon.'],
  packed: ['Order packed', 'Your items are packed and ready to go.'],
  shipped: ['Order on its way', 'Your items have left us and are on their way to you.'],
  delivered: ['Order delivered', 'Your order was delivered. We hope you enjoy it.'],
  cancelled: ['Part of your order was cancelled', 'We had to cancel some items. We will contact you about your refund.'],
};

function shipmentChanged(order, user, shipment) {
  const note = SHIPMENT_NOTE[shipment.status];
  // A vendor who delivers their own order gets a 6-digit code made for the customer. It is only in the customer's own
  // order page, text and email, and the customer gives it to the person who hands over the items.
  const code = shipment.status === 'shipped' && shipment.fulfilledBy === 'vendor' ? shipment.deliveryCode : null;
  if (note) {
    const extra = code ? ` Delivery code: ${code}. Give it only to the person who hands you the items.` : '';
    notifyUser(user._id, { type: `shipment_${shipment.status}`, title: note[0], body: `Order ${order.orderNumber}. ${note[1]}${extra}`, link: `/orders/${order.orderNumber}` });
  }
  emails.shipmentUpdate(order, user, shipment);
  const text = SHIPMENT_SMS[shipment.status];
  if (code) {
    sendSms({ to: order.address.phone, message: `Square Market: your order ${order.orderNumber} is on its way. Delivery code ${code}. Give it only to the person who hands you the items.` });
  } else if (text) {
    sendSms({ to: order.address.phone, message: text(order.orderNumber) });
  }
}

// The customer follows ONE order, however many vendors it came from. So they are told when the whole order moves on
// ("Your order is packed", "Your order is on its way"), not every time one vendor's package does.
// Two things are still said per package: the delivery code for a package a vendor delivers themselves, and a cancelled package.
function orderProgressed(order, user, { before, after, shipment }) {
  if (shipment.status === 'shipped' && shipment.fulfilledBy === 'vendor') return shipmentChanged(order, user, shipment);
  if (shipment.status === 'cancelled') return shipmentChanged(order, user, shipment);

  if (after.index > before.index) {
    // The whole order reached a new stage.
    return shipmentChanged(order, user, { status: after.stage, items: order.items, fulfilledBy: 'platform' });
  }
  if (shipment.status === 'shipped' && before.packages.onTheWay === 0 && after.packages.onTheWay > 0) {
    notifyUser(user._id, {
      type: 'order_partly_shipped',
      title: 'Part of your order is on its way',
      body: `Order ${order.orderNumber}: ${after.packages.onTheWay} of ${after.packages.live} packages have shipped. The rest will follow.`,
      link: `/orders/${order.orderNumber}`,
    });
  }
  return undefined;
}

module.exports = { orderPaid, orderPlacedCod, shipmentChanged, orderProgressed };
