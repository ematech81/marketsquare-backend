const router = require('express').Router();
const { z } = require('zod');
const Shipment = require('../models/Shipment');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { requireVendor } = require('../middleware/vendor');
const HttpError = require('../utils/httpError');
const { moveShipment, MAX_CODE_TRIES } = require('../services/shipments');
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
  // Who delivers it. A vendor who delivers must give courier details when shipping, and the customer's code when delivering.
  fulfilledBy: s.fulfilledBy,
  deliveryFee: s.deliveryFee,
  delivery: s.delivery,
  deliveredBy: s.deliveredBy,
  codeTriesLeft: Math.max(0, MAX_CODE_TRIES - (s.codeAttempts ?? 0)),
  dispute: s.dispute?.status ? { status: s.dispute.status, reason: s.dispute.reason } : undefined,
  // What the vendor earns from it, and when it can be paid out. The delivery code is never sent to the vendor.
  earning: s.earning?.net !== undefined ? { net: s.earning.net, commission: s.earning.commission, releaseAt: s.earning.releaseAt, releasedAt: s.earning.releasedAt } : undefined,
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

const statusSchema = z.object({
  status: z.enum(['confirmed', 'packed', 'shipped', 'delivered', 'cancelled']),
  // When shipping an order the vendor delivers themselves: who is carrying it.
  courierName: z.string().trim().max(80).optional(),
  courierPhone: z.string().trim().max(20).optional(),
  note: z.string().trim().max(300).optional(),
  // When marking it delivered: the 6-digit code the customer gives the person delivering.
  code: z.string().trim().regex(/^\d{6}$/, 'The code is 6 digits').optional(),
});

// Vendors confirm, pack and ship. Delivery pays the vendor, so it is protected:
//   - When Square Market delivers, only Square Market marks it delivered.
//   - When the vendor delivers, they must enter the customer's 6-digit code (or the customer confirms it themselves).
router.patch('/shipments/:id/status', validate(statusSchema), async (req, res) => {
  const shipment = await Shipment.findOne({ _id: req.params.id, vendor: req.vendor._id });
  if (!shipment) throw new HttpError(404, 'Shipment not found');

  const { status } = req.body;
  if (shipment.dispute?.status === 'open') throw new HttpError(409, 'The customer reported a problem with this order. Square Market will contact you');
  if (status === 'cancelled' && !['placed', 'confirmed', 'packed'].includes(shipment.status)) {
    throw new HttpError(409, 'A shipment that is already on its way cannot be cancelled. Contact Square Market');
  }
  await moveShipment(shipment, status, ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled'], {
    by: 'vendor',
    delivery: { courierName: req.body.courierName, courierPhone: req.body.courierPhone, note: req.body.note },
    code: req.body.code,
  });

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
