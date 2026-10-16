const router = require('express').Router();
const { z } = require('zod');
const Vendor = require('../models/Vendor');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { requireVendor } = require('../middleware/vendor');
const HttpError = require('../utils/httpError');
const states = require('../utils/nigeriaStates');

router.use(protect, requireVendor);

// How this vendor's orders are delivered, and the fees they charge for the states they serve.
router.get('/delivery', async (req, res) => {
  const v = await Vendor.findById(req.vendor._id);
  res.json({ mode: v.deliveryMode, locked: v.deliveryLocked, rates: v.deliveryRates });
});

const schema = z.object({
  mode: z.enum(['platform', 'self']),
  rates: z
    .array(
      z.object({
        state: z.enum(states, { message: 'Unknown state' }),
        fee: z.number().int('Fee must be a whole number of Naira').min(0).max(500000),
        estimatedDays: z.number().int().min(1).max(30).default(3),
      })
    )
    .default([]),
});

// Choose who delivers. Delivering yourself needs a fee for at least one state, and the admin can switch it off for a vendor.
router.put('/delivery', validate(schema), async (req, res) => {
  const { mode, rates } = req.body;
  const v = await Vendor.findById(req.vendor._id);
  if (mode === 'self' && v.deliveryLocked) {
    throw new HttpError(403, 'Square Market delivers your orders. Contact Square Market if you want to deliver them yourself');
  }
  if (new Set(rates.map((r) => r.state)).size !== rates.length) throw new HttpError(400, 'rates: A state is listed twice');
  if (mode === 'self' && rates.length === 0) throw new HttpError(400, 'rates: Add the states you deliver to, with your delivery fee for each');

  v.deliveryMode = mode;
  v.deliveryRates = rates;
  await v.save();
  res.json({ mode: v.deliveryMode, locked: v.deliveryLocked, rates: v.deliveryRates });
});

module.exports = router;
