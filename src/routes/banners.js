const router = require('express').Router();
const { z } = require('zod');
const Banner = require('../models/Banner');
const validate = require('../middleware/validate');
const { protect, requireRole } = require('../middleware/auth');
const HttpError = require('../utils/httpError');
const { signUpload } = require('../utils/cloudinary');

// The home page shows at most this many banners.
const MAX_BANNERS = 6;

// ---------- Public: what the home page shows ----------

router.get('/banners', async (req, res) => {
  const banners = await Banner.find({ active: true }).sort({ order: 1, createdAt: 1 }).limit(MAX_BANNERS);
  res.json({
    banners: banners.map((b) => ({
      id: b._id,
      image: b.image.url,
      width: b.image.width,
      height: b.image.height,
      mobileImage: b.mobileImage?.url,
      alt: b.alt,
      link: b.link || undefined,
    })),
  });
});

// ---------- Admin: add, change, order and remove banners ----------

const admin = require('express').Router();
admin.use(protect, requireRole('admin'));

const image = z.object({
  url: z.string().url().refine((u) => u.startsWith('https://'), 'The image address must start with https://'),
  publicId: z.string().optional(),
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
});

// A link may only go to a page on this site, or to a full https:// address. This blocks "javascript:" and similar tricks.
const link = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^\/(?!\/)/.test(v) || /^https:\/\/[^\s]+$/i.test(v), 'The link must start with / (a page on this site) or https://')
  .optional()
  .transform((v) => v || undefined);

const bannerSchema = z.object({
  title: z.string().trim().min(2, 'Give the banner a name').max(80),
  image,
  mobileImage: image.optional(),
  alt: z.string().trim().min(3, 'Describe what the banner shows, in a few words').max(125, 'Keep the description under 125 characters'),
  link,
  active: z.boolean().default(true),
});

admin.get('/banners', async (req, res) => {
  const banners = await Banner.find().sort({ order: 1, createdAt: 1 });
  res.json({ banners, max: MAX_BANNERS });
});

admin.get('/banners/:id', async (req, res) => {
  const banner = await Banner.findById(req.params.id);
  if (!banner) throw new HttpError(404, 'Banner not found');
  res.json({ banner });
});

admin.post('/banners', validate(bannerSchema), async (req, res) => {
  if ((await Banner.countDocuments()) >= MAX_BANNERS) {
    throw new HttpError(409, `The home page can show ${MAX_BANNERS} banners. Remove one before adding another`);
  }
  const last = await Banner.findOne().sort({ order: -1 });
  const banner = await Banner.create({ ...req.body, order: (last?.order ?? -1) + 1 });
  res.status(201).json({ banner });
});

admin.put('/banners/:id', validate(bannerSchema), async (req, res) => {
  const banner = await Banner.findById(req.params.id);
  if (!banner) throw new HttpError(404, 'Banner not found');
  banner.set({ ...req.body, mobileImage: req.body.mobileImage });
  await banner.save();
  res.json({ banner });
});

// Sets the order: the ids, first to last.
admin.patch('/banners-order', validate(z.object({ ids: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(MAX_BANNERS) })), async (req, res) => {
  await Banner.bulkWrite(req.body.ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i } } } })));
  res.json({ banners: await Banner.find().sort({ order: 1, createdAt: 1 }) });
});

admin.patch('/banners/:id/active', validate(z.object({ active: z.boolean() })), async (req, res) => {
  const banner = await Banner.findByIdAndUpdate(req.params.id, { active: req.body.active }, { new: true });
  if (!banner) throw new HttpError(404, 'Banner not found');
  res.json({ banner });
});

admin.delete('/banners/:id', async (req, res) => {
  const banner = await Banner.findByIdAndDelete(req.params.id);
  if (!banner) throw new HttpError(404, 'Banner not found');
  res.json({ ok: true });
});

admin.post('/banners-upload-sign', (req, res) => {
  res.json(signUpload('squaremarket/banners', req.body?.name));
});

module.exports = { publicRouter: router, adminRouter: admin };
