const router = require('express').Router();
const { z } = require('zod');
const Shipment = require('../models/Shipment');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { requireVendor } = require('../middleware/vendor');
const HttpError = require('../utils/httpError');
const { moveShipment } = require('../services/shipments');
const { grossOf } = require('../services/wallet');
const { sendMail } = require('../services/mailer');

router.use(protect, requireVendor);

const OPEN = ['placed', 'confirmed', 'packed', 'shipped'];

const row = (s) => ({
  id: s._id,
  orderNumber: s.order?.orderNumber,
  status: s.status,
  createdAt: s.createdAt,
  estimatedDelivery: s.estimatedDelivery,
  items: s.items,
  itemsTotal: grossOf(s),
  // The vendor needs these to ship the order.
  address: s.order?.address,
});

// The vendor's own shipments. A vendor never sees another vendor's orders.
router.get('/orders', async (req, res) => {
  const filter = String(req.query.filter ?? 'open');
  const all = await Shipment.find({ vendor: req.vendor._id }).populate('order', 'orderNumber address').sort({ createdAt: -1 }).limit(300);

  const counts = {
    open: all.filter((s) => OPEN.includes(s.status)).length,
    toConfirm: all.filter((s) => s.status === 'placed').length,
  };
  const shown = all.filter((s) => (filter === 'open' ? OPEN.includes(s.status) : filter === 'done' ? !OPEN.includes(s.status) : true));
  res.json({ shipments: shown.map(row), counts });
});

// Vendors confirm, pack and ship. Marking it delivered is the admin's job, because delivery pays the vendor.
router.patch('/shipments/:id/status', validate(z.object({ status: z.enum(['confirmed', 'packed', 'shipped', 'cancelled']) })), async (req, res) => {
  const shipment = await Shipment.findOne({ _id: req.params.id, vendor: req.vendor._id });
  if (!shipment) throw new HttpError(404, 'Shipment not found');

  const { status } = req.body;
  if (status === 'cancelled' && !['placed', 'confirmed', 'packed'].includes(shipment.status)) {
    throw new HttpError(409, 'A shipment that is already on its way cannot be cancelled. Contact Square Market');
  }
  await moveShipment(shipment, status, ['confirmed', 'packed', 'shipped', 'cancelled']);

  // The customer has paid, so the admin must know to arrange the refund.
  if (status === 'cancelled') {
    sendMail({
      to: process.env.ADMIN_ALERT_EMAIL,
      subject: `${req.vendor.businessName} cancelled a shipment`,
      text: `${req.vendor.businessName} cancelled a shipment that was already paid for. Please refund the customer from your KoraPay dashboard.`,
      html: `<p>${req.vendor.businessName} cancelled a shipment that was already paid for. Please refund the customer from your KoraPay dashboard.</p>`,
    });
  }
  res.json({ shipment });
});

module.exports = router;
