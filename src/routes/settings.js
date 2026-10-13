const router = require('express').Router();
const { minOrderAmount, returnDays } = require('../config/env');
const { getStoreSettings } = require('../services/storeSettings');

// Store rules the websites show to customers and vendors.
router.get('/settings', async (req, res) => {
  const { requireListingApproval } = await getStoreSettings();
  res.json({ minOrderAmount, returnDays, requireListingApproval });
});

module.exports = router;
