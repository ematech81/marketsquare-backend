const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/env');
const User = require('../models/User');
const HttpError = require('../utils/httpError');

async function protect(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Please sign in');

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch {
    throw new HttpError(401, 'Your session has expired. Please sign in again');
  }

  const user = await User.findById(payload.sub);
  if (!user) throw new HttpError(401, 'Account not found');
  if (user.status === 'suspended') throw new HttpError(403, 'This account is suspended');

  req.user = user;
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) throw new HttpError(403, 'You do not have access to this');
  next();
};

module.exports = { protect, requireRole };
