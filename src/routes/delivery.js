const router = require('express').Router();
const { z } = require('zod');
const DeliveryZone = require('../models/DeliveryZone');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const states = require('../utils/nigeriaStates');
const Vendor = require('../models/Vendor');
const { quoteForSeller } = require('../services/delivery');

// Public: which states we deliver to, and what it costs.
router.get('/delivery-zones', async (req, res) => {
  const zones = await DeliveryZone.find().sort({ state: 1 });
  res.json({ zones: zones.map((z) => ({ state: z.state, fee: z.fee, estimatedDays: z.estimatedDays })) });
});

// Public: what delivery costs from one seller to one state. `vendor` is a vendor id, or left out for the store's own products.
router.get('/delivery-quote', async (req, res) => {
  const state = String(req.query.state ?? '');
  if (!states.includes(state)) return res.status(400).json({ message: 'state: Choose a state' });
  const id = String(req.query.vendor ?? '');
  const vendor = /^[a-f\d]{24}$/i.test(id) ? await Vendor.findOne({ _id: id, status: 'approved' }) : null;
  const quote = await quoteForSeller(vendor, state);
  res.json(quote ? { available: true, mode: quote.mode, fee: quote.fee, estimatedDays: quote.estimatedDays } : { available: false });
});

// The states a seller delivers to, so the product page can offer only those.
router.get('/delivery-states', async (req, res) => {
  const id = String(req.query.vendor ?? '');
  const vendor = /^[a-f\d]{24}$/i.test(id) ? await Vendor.findOne({ _id: id, status: 'approved' }) : null;
  if (vendor && vendor.deliveryMode === 'self' && !vendor.deliveryLocked) {
    return res.json({ mode: 'vendor', zones: vendor.deliveryRates.map((r) => ({ state: r.state, fee: r.fee, estimatedDays: r.estimatedDays })).sort((a, b) => a.state.localeCompare(b.state)) });
  }
  const zones = await DeliveryZone.find().sort({ state: 1 });
  res.json({ mode: 'platform', zones: zones.map((z) => ({ state: z.state, fee: z.fee, estimatedDays: z.estimatedDays })) });
});

const saveSchema = z.object({
  zones: z.array(
    z.object({
      state: z.enum(states, { message: 'Unknown state' }),
      fee: z.number().int('Fee must be a whole number of Naira').min(0),
      estimatedDays: z.number().int().min(1).max(30).default(3),
    })
  ),
});

// Admin: replaces the whole list. A state left out is no longer delivered to.
router.put('/admin/delivery-zones', protect, requireRole('admin'), validate(saveSchema), async (req, res) => {
  const { zones } = req.body;
  const seen = new Set(zones.map((z) => z.state));
  if (seen.size !== zones.length) return res.status(400).json({ message: 'zones: A state is listed twice' });

  await DeliveryZone.bulkWrite([
    { deleteMany: { filter: { state: { $nin: [...seen] } } } },
    ...zones.map((z) => ({ updateOne: { filter: { state: z.state }, update: { $set: z }, upsert: true } })),
  ]);
  const saved = await DeliveryZone.find().sort({ state: 1 });
  res.json({ zones: saved });
});

module.exports = router;
