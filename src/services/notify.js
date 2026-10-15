// One place that decides who is told what, by email and by SMS.
const Vendor = require('../models/Vendor');
const emails = require('./emails');
const { sendSms } = require('./sms');

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
    sendSms({ to: vendor.phone, message: `Square Market: new order ${order.orderNumber} for ${vendor.businessName}. Open your dashboard to confirm it.` });
  }
}

// Payment confirmed: receipt to the customer, alert to the owner, alert to each vendor involved.
function orderPaid(order, user) {
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
  emails.orderReceived(order, user);
  emails.newOrderAlert(order, user);
  sendSms({ to: order.address.phone, message: `Square Market: we received your order ${order.orderNumber}. Please have ${order.total} Naira ready to pay when it arrives.` });
  sendSms({
    to: process.env.ADMIN_ALERT_PHONE,
    message: `New PAY ON DELIVERY order ${order.orderNumber}, ${order.total} Naira, ${order.address.state}.`,
  });
  alertVendors(order).catch((err) => console.error('Vendor alert failed:', err.message));
}

function shipmentChanged(order, user, shipment) {
  emails.shipmentUpdate(order, user, shipment);
  const text = SHIPMENT_SMS[shipment.status];
  if (text) sendSms({ to: order.address.phone, message: text(order.orderNumber) });
}

module.exports = { orderPaid, orderPlacedCod, shipmentChanged };
