const crypto = require('crypto');
const HttpError = require('../utils/httpError');

const BASE = 'https://api.korapay.com/merchant/api/v1';

const secretKey = () => {
  const key = process.env.KORAPAY_SECRET_KEY;
  if (!key) throw new HttpError(503, 'Payments are not set up yet');
  return key;
};

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/json' },
    });
  } catch {
    throw new HttpError(502, 'Could not reach the payment provider. Please try again');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    console.error('KoraPay error', res.status, data.message);
    throw new HttpError(502, 'The payment provider rejected this request. Please try again');
  }
  return data.data;
}

// Starts a hosted checkout. notification_url is deliberately NOT sent: every KoraPay webhook goes
// to the shared router, which forwards it to this app by reference prefix.
async function initializeCharge({ amount, currency, reference, customer, redirectUrl }) {
  return request('/charges/initialize', {
    method: 'POST',
    body: JSON.stringify({ amount, currency, reference, customer, redirect_url: redirectUrl }),
  });
}

async function verifyCharge(reference) {
  return request(`/charges/${encodeURIComponent(reference)}`);
}

// KoraPay signs only the `data` object, with the account's secret key (HMAC-SHA256, hex).
function isValidSignature(data, signature) {
  if (!signature || !process.env.KORAPAY_SECRET_KEY) return false;
  const expected = crypto.createHmac('sha256', process.env.KORAPAY_SECRET_KEY).update(JSON.stringify(data)).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { initializeCharge, verifyCharge, isValidSignature };
