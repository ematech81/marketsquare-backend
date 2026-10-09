const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { signToken } = require('../utils/token');
const HttpError = require('../utils/httpError');

const phone = z.string().trim().regex(/^(\+234|0)\d{10}$/, 'Enter a valid Nigerian phone number');

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name'),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  phone,
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
});

router.post('/register', validate(registerSchema), async (req, res) => {
  const { name, email, phone: phoneNumber, password } = req.body;
  if (await User.exists({ email })) throw new HttpError(409, 'An account with this email already exists');

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ name, email, phone: phoneNumber, passwordHash });
  res.status(201).json({ token: signToken(user), user: user.toPublic() });
});

router.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select('+passwordHash');
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) throw new HttpError(401, 'Email or password is incorrect');
  if (user.status === 'suspended') throw new HttpError(403, 'This account is suspended');

  res.json({ token: signToken(user), user: user.toPublic() });
});

router.get('/me', protect, async (req, res) => {
  const vendor = await Vendor.findOne({ user: req.user._id }).select('businessName status rejectionReason');
  res.json({ user: req.user.toPublic(), vendor });
});

module.exports = router;
