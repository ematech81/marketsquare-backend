const Notification = require('../models/Notification');
const User = require('../models/User');

// In-app notifications. They never throw: a problem here must not break an order, a payment or a approval.
// Pass `user` as an id (or a user document).
async function notifyUser(user, { type, title, body, link }) {
  try {
    if (!user) return null;
    return await Notification.create({ user: user._id ?? user, type, title, body, link });
  } catch (err) {
    console.error('Notification failed:', err.message);
    return null;
  }
}

// Every admin account hears about it (the shop owner, and anyone they add).
async function notifyAdmins(content) {
  try {
    const admins = await User.find({ role: 'admin' }).select('_id');
    await Promise.all(admins.map((a) => notifyUser(a._id, content)));
  } catch (err) {
    console.error('Admin notification failed:', err.message);
  }
}

module.exports = { notifyUser, notifyAdmins };
