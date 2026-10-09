const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { signToken } = require('../utils/token');
const HttpError = require('../utils/httpError');
const crypto = require('crypto');
const { authLimiter } = require('../middleware/rateLimit');
const { webUrl } = require('../config/env');
const emails = require('../services/emails');

router.use(['/login', '/register', '/forgot', '/reset'], authLimiter);

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

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Always answers the same way, so nobody can use this to find out which emails have accounts.
router.post('/forgot', validate(z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email') })), async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (user && user.status === 'active') {
    const token = crypto.randomBytes(32).toString('hex');
    user.resetTokenHash = sha256(token);
    user.resetExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();
    emails.passwordReset(user, `${webUrl}/reset-password?token=${token}`);
  }
  res.json({ message: 'If that email has an account, we have sent a link to reset the password.' });
});

router.post('/reset', validate(z.object({ token: z.string().min(20), password: z.string().min(8, 'Password must be at least 8 characters') })), async (req, res) => {
  const user = await User.findOne({ resetTokenHash: sha256(req.body.token), resetExpires: { $gt: new Date() } }).select('+resetTokenHash +resetExpires');
  if (!user) throw new HttpError(400, 'This reset link is not valid or has expired. Ask for a new one');
  user.passwordHash = await bcrypt.hash(req.body.password, 12);
  user.resetTokenHash = undefined;
  user.resetExpires = undefined;
  await user.save();
  res.json({ message: 'Your password has been changed. You can sign in now.' });
});

router.get('/me', protect, async (req, res) => {
  const vendor = await Vendor.findOne({ user: req.user._id }).select('businessName status rejectionReason');
  res.json({ user: req.user.toPublic(), vendor });
});

module.exports = router;
