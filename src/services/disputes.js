const Shipment = require('../models/Shipment');
const Order = require('../models/Order');
const Vendor = require('../models/Vendor');
const HttpError = require('../utils/httpError');
const wallet = require('./wallet');
const { notifyUser, notifyAdmins } = require('./notifications');

// A customer reports a problem with a shipment ("it never came", "it is not what I ordered").
// While it is open, the vendor's money for it is not released. Only the admin can settle it.
async function openDispute(shipment, reason) {
  const text = String(reason ?? '').trim();
  if (text.length < 10) throw new HttpError(400, 'reason: Tell us what is wrong, in a sentence or two');
  if (text.length > 500) throw new HttpError(400, 'reason: Please keep it under 500 characters');
  if (!['shipped', 'delivered'].includes(shipment.status)) {
    throw new HttpError(409, 'You can report a problem once your order has shipped');
  }
  if (shipment.dispute?.status === 'open') throw new HttpError(409, 'You already reported a problem with this order. Square Market is looking into it');
  if (shipment.earning?.releasedAt) {
    throw new HttpError(409, 'The protection period for this order is over. Please contact Square Market support');
  }

  const opened = await Shipment.findOneAndUpdate(
    { _id: shipment._id, 'dispute.status': { $ne: 'open' }, 'earning.releasedAt': { $exists: false } },
    { $set: { dispute: { status: 'open', reason: text, openedAt: new Date() } } },
    { new: true }
  );
  if (!opened) throw new HttpError(409, 'This order cannot be reported right now');

  const order = await Order.findById(shipment.order).select('orderNumber');
  notifyAdmins({ type: 'admin_dispute', title: 'A customer reported a problem', body: `Order ${order?.orderNumber}: ${text.slice(0, 120)}`, link: `/orders/${order?.orderNumber}` });
  if (shipment.vendor) {
    const vendor = await Vendor.findById(shipment.vendor).select('user');
    notifyUser(vendor?.user, {
      type: 'vendor_dispute',
      title: 'A customer reported a problem',
      body: `Order ${order?.orderNumber}. Square Market will look into it. Your earnings for it are on hold.`,
      link: '/orders',
    });
  }
  return opened;
}

// The admin decides: 'release' (the vendor did nothing wrong, pay them) or 'refund' (take the vendor's earnings back,
// and refund the customer from the KoraPay dashboard).
async function resolveDispute(shipment, resolution, note) {
  if (shipment.dispute?.status !== 'open') throw new HttpError(409, 'There is no open problem on this shipment');
  if (!['release', 'refund'].includes(resolution)) throw new HttpError(400, 'resolution: Choose release or refund');

  const status = resolution === 'release' ? 'released' : 'refunded';
  await Shipment.updateOne({ _id: shipment._id }, { $set: { 'dispute.status': status, 'dispute.resolvedAt': new Date(), 'dispute.note': String(note ?? '').slice(0, 300) } });

  let takenBack = 0;
  if (resolution === 'release') {
    // Nothing more to wait for: the earnings go to the vendor now.
    if (shipment.earning?.net !== undefined) {
      await Shipment.updateOne({ _id: shipment._id }, { $set: { 'earning.releaseAt': new Date() } });
      await wallet.releaseOne(shipment._id);
    }
  } else if (shipment.earning?.net !== undefined) {
    takenBack = await wallet.reverseCredit(shipment);
  }

  const order = await Order.findById(shipment.order).select('orderNumber user');
  if (shipment.vendor) {
    const vendor = await Vendor.findById(shipment.vendor).select('user');
    notifyUser(vendor?.user, {
      type: 'dispute_resolved',
      title: resolution === 'release' ? 'The problem was settled in your favour' : 'A customer problem was upheld',
      body: resolution === 'release' ? `Order ${order?.orderNumber}: your earnings are released.` : `Order ${order?.orderNumber}: the earnings for it were taken back.`,
      link: '/wallet',
    });
  }
  notifyUser(order?.user, {
    type: 'dispute_resolved',
    title: 'Your problem report was reviewed',
    body: resolution === 'refund' ? `Order ${order?.orderNumber}: we will refund you.` : `Order ${order?.orderNumber}: we reviewed it and the order stands.`,
    link: `/orders/${order?.orderNumber}`,
  });
  return { status, takenBack };
}

module.exports = { openDispute, resolveDispute };
