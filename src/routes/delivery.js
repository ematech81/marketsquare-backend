const router = require('express').Router();
const { z } = require('zod');
const DeliveryZone = require('../models/DeliveryZone');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const states = require('../utils/nigeriaStates');

// Public: which states we deliver to, and what it costs.
router.get('/delivery-zones', async (req, res) => {
  const zones = await DeliveryZone.find().sort({ state: 1 });
  res.json({ zones: zones.map((z) => ({ state: z.state, fee: z.fee, estimatedDays: z.estimatedDays })) });
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
