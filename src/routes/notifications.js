const router = require('express').Router();
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');
const HttpError = require('../utils/httpError');

router.use(protect);

const view = (n) => ({ id: n._id, type: n.type, title: n.title, body: n.body, link: n.link, read: n.read, createdAt: n.createdAt });

// The newest first, and how many are still unread.
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '30'), 10) || 30, 1), 100);
  const [items, unread] = await Promise.all([
    Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(limit),
    Notification.countDocuments({ user: req.user._id, read: false }),
  ]);
  res.json({ notifications: items.map(view), unread });
});

// Light enough for the bell to ask every minute or so.
router.get('/unread-count', async (req, res) => {
  res.json({ unread: await Notification.countDocuments({ user: req.user._id, read: false }) });
});

router.post('/read-all', async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
  res.json({ unread: 0 });
});

router.patch('/:id/read', async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new HttpError(404, 'Notification not found');
  // Matching on the user too means nobody can touch someone else's notification.
  const n = await Notification.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { read: true }, { new: true });
  if (!n) throw new HttpError(404, 'Notification not found');
  res.json({ notification: view(n), unread: await Notification.countDocuments({ user: req.user._id, read: false }) });
});

module.exports = router;
