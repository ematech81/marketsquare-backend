// One place that decides who is told what, by email and by SMS.
const emails = require('./emails');
const { sendSms } = require('./sms');

// SMS text avoids the Naira sign and other special characters, which would split it into extra, pricier messages.
const SHIPMENT_SMS = {
  shipped: (n) => `Square Market: your order ${n} is on its way to you.`,
  delivered: (n) => `Square Market: your order ${n} has been delivered. Thank you for shopping with us!`,
  cancelled: (n) => `Square Market: part of your order ${n} was cancelled. We will contact you about your refund.`,
};

// Payment confirmed: receipt to the customer, alert to the owner.
function orderPaid(order, user) {
  emails.orderReceived(order, user);
  emails.newOrderAlert(order, user);
  sendSms({ to: order.address.phone, message: `Square Market: we received your payment for order ${order.orderNumber}. We will deliver it to you soon.` });
  sendSms({
    to: process.env.ADMIN_ALERT_PHONE,
    message: `New paid order ${order.orderNumber}, ${order.total} Naira, ${order.address.state}.`,
  });
}

function shipmentChanged(order, user, shipment) {
  emails.shipmentUpdate(order, user, shipment);
  const text = SHIPMENT_SMS[shipment.status];
  if (text) sendSms({ to: order.address.phone, message: text(order.orderNumber) });
}

module.exports = { orderPaid, shipmentChanged };
