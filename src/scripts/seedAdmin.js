// Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... npm run seed:admin
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const connectDb = require('../config/db');
const User = require('../models/User');

async function run() {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  const name = process.env.ADMIN_NAME || 'Admin';
  const phone = process.env.ADMIN_PHONE || '08000000000';
  if (!email || password.length < 8) {
    console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (8+ characters)');
    process.exit(1);
  }

  await connectDb();
  const passwordHash = await bcrypt.hash(password, 12);
  await User.findOneAndUpdate(
    { email },
    { name, email, phone, passwordHash, role: 'admin', status: 'active' },
    { upsert: true, setDefaultsOnInsert: true }
  );
  console.log(`Admin ready: ${email}`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
