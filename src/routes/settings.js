const router = require('express').Router();
const { minOrderAmount, returnDays } = require('../config/env');

// Store rules the website shows to customers.
router.get('/settings', (req, res) => {
  res.json({ minOrderAmount, returnDays });
});

module.exports = router;
