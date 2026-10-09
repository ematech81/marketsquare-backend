const rateLimit = require('express-rate-limit');

const make = (max, message) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message },
    // Tests fire many requests in a row, so they switch this off.
    skip: () => process.env.DISABLE_RATE_LIMIT === '1',
  });

// Slows down password guessing and account spam.
const authLimiter = make(30, 'Too many attempts. Please wait a few minutes and try again.');
// Stops a script from creating piles of unpaid orders.
const checkoutLimiter = make(40, 'Too many checkout attempts. Please wait a few minutes.');

module.exports = { authLimiter, checkoutLimiter };
