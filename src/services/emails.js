const { sendMail } = require('./mailer');
const { webUrl } = require('../config/env');

const naira = (n) => `₦${Number(n).toLocaleString('en-NG')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Plain, readable layout that matches the site: dark text, orange accent, sharp corners.
const wrap = (title, bodyHtml) => `<!doctype html><html><body style="margin:0;background:#F8F9FA;font-family:Arial,Helvetica,sans-serif;color:#111317">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="font-size:20px;font-weight:700;margin-bottom:16px"><span style="display:inline-block;width:14px;height:14px;background:#D95D39;margin-right:8px"></span>Square Market</div>
<div style="background:#fff;border:1px solid #E2E5E9;padding:24px">
<h1 style="margin:0 0 16px;font-size:22px">${esc(title)}</h1>
${bodyHtml}
</div>
<p style="font-size:12px;color:#4A5568;margin-top:16px">Square Market, delivered across Nigeria.</p>
</div></body></html>`;

const button = (href, label) =>
  `<p style="margin:24px 0 0"><a href="${esc(href)}" style="background:#D95D39;color:#111317;text-decoration:none;font-weight:700;padding:12px 24px;display:inline-block">${esc(label)}</a></p>`;

const itemLines = (items) => items.map((i) => `${i.quantity} x ${i.title} - ${naira(i.price * i.quantity)}`);
const itemRows = (items) =>
  items.map((i) => `<tr><td style="padding:6px 0">${esc(i.quantity)} × ${esc(i.title)}</td><td style="padding:6px 0;text-align:right">${naira(i.price * i.quantity)}</td></tr>`).join('');

const orderLink = (order) => `${webUrl}/orders/${order.orderNumber}`;

// The receipt sent to the customer once payment is confirmed.
function orderReceived(order, user) {
  const to = order.contactEmail || user.email;
  const subject = `We got your order ${order.orderNumber}`;
  const text = [
    `Hi ${user.name},`,
    '',
    `Thank you. We have received your payment for order ${order.orderNumber}.`,
    '',
    ...itemLines(order.items),
    `Delivery: ${naira(order.deliveryTotal)}`,
    `Total paid: ${naira(order.total)}`,
    '',
    `We will deliver to: ${order.address.street}, ${order.address.city}, ${order.address.state}.`,
    `Follow your order: ${orderLink(order)}`,
  ].join('\n');
  const html = wrap(
    'We got your order',
    `<p>Hi ${esc(user.name)}, thank you. We have received your payment for order <strong>${esc(order.orderNumber)}</strong>.</p>
<table style="width:100%;border-collapse:collapse;font-size:15px">${itemRows(order.items)}
<tr><td style="padding:6px 0;color:#4A5568">Delivery</td><td style="padding:6px 0;text-align:right">${naira(order.deliveryTotal)}</td></tr>
<tr><td style="padding:10px 0;border-top:2px solid #111317;font-weight:700">Total paid</td><td style="padding:10px 0;border-top:2px solid #111317;text-align:right;font-weight:700">${naira(order.total)}</td></tr></table>
<p style="color:#4A5568">We will deliver to ${esc(order.address.street)}, ${esc(order.address.city)}, ${esc(order.address.state)}.</p>
${button(orderLink(order), 'Follow your order')}`,
  );
  return sendMail({ to, subject, text, html });
}

// Sent to the shop owner so a new order is never missed.
function newOrderAlert(order, user) {
  const to = process.env.ADMIN_ALERT_EMAIL;
  const subject = `New order ${order.orderNumber}: ${naira(order.total)}`;
  const text = [
    `A new paid order came in.`,
    '',
    `Order: ${order.orderNumber}`,
    `Customer: ${user.name}, ${order.address.phone}`,
    ...itemLines(order.items),
    `Total paid: ${naira(order.total)}`,
    `Deliver to: ${order.address.street}, ${order.address.city}, ${order.address.state}`,
    order.needsAttention ? `NEEDS ATTENTION: ${order.needsAttention}` : '',
  ].filter(Boolean).join('\n');
  const html = wrap('New order', `<p>${esc(text).replace(/\n/g, '<br>')}</p>`);
  return sendMail({ to, subject, text, html });
}

const STATUS_MAIL = {
  shipped: { subject: 'is on its way', heading: 'Your order is on its way', line: 'Your items have left us and are on their way to you.' },
  delivered: { subject: 'has been delivered', heading: 'Your order was delivered', line: 'Your items have been delivered. We hope you enjoy them.' },
  cancelled: { subject: 'was cancelled', heading: 'Part of your order was cancelled', line: 'We had to cancel some items in your order. We will contact you about your refund.' },
};

// Sent when a shipment is shipped, delivered or cancelled.
function shipmentUpdate(order, user, shipment) {
  const info = STATUS_MAIL[shipment.status];
  if (!info) return Promise.resolve({ skipped: true });
  const to = order.contactEmail || user.email;
  const subject = `Your order ${order.orderNumber} ${info.subject}`;
  const text = [`Hi ${user.name},`, '', info.line, '', ...itemLines(shipment.items), '', `Follow your order: ${orderLink(order)}`].join('\n');
  const html = wrap(
    info.heading,
    `<p>Hi ${esc(user.name)}, ${esc(info.line)}</p>
<table style="width:100%;border-collapse:collapse;font-size:15px">${itemRows(shipment.items)}</table>
${button(orderLink(order), 'View your order')}`,
  );
  return sendMail({ to, subject, text, html });
}

// Tells a vendor applicant what we decided.
function vendorDecision(vendor, user, status, reason) {
  const approved = status === 'approved';
  const subject = approved ? 'Your Square Market vendor application is approved' : 'About your Square Market vendor application';
  const text = approved
    ? `Hi ${user.name},\n\nGood news. ${vendor.businessName} is approved to sell on Square Market.\n\n${webUrl}`
    : status === 'suspended'
      ? `Hi ${user.name},\n\nYour vendor account for ${vendor.businessName} has been suspended. Please contact Square Market support.`
      : `Hi ${user.name},\n\nWe could not approve ${vendor.businessName} yet.\nReason: ${reason}\n\nYou can fix the details and apply again at ${webUrl}/become-a-vendor`;
  const html = wrap(subject, `<p>${esc(text).replace(/\n/g, '<br>')}</p>`);
  return sendMail({ to: user.email, subject, text, html });
}

function passwordReset(user, link) {
  const subject = 'Reset your Square Market password';
  const text = `Hi ${user.name},\n\nUse this link to choose a new password. It works for one hour.\n${link}\n\nIf you did not ask for this, you can ignore this email.`;
  const html = wrap('Reset your password', `<p>Hi ${esc(user.name)}, use the button below to choose a new password. It works for one hour.</p>${button(link, 'Choose a new password')}<p style="color:#4A5568;font-size:13px">If you did not ask for this, you can ignore this email.</p>`);
  return sendMail({ to: user.email, subject, text, html });
}

module.exports = { orderReceived, newOrderAlert, shipmentUpdate, vendorDecision, passwordReset };
