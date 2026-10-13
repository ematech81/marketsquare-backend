const { z } = require('zod');

// Empty boxes on the form arrive as "". Treat them as "not filled in".
const optionalText = (max, message) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((v) => (v ? v : undefined));

// The product form, shared by the admin and by vendors. `status` is what the person asked for: save as a draft,
// or publish. Vendors' "publish" may land in review first (see routes/vendorProducts.js).
const productSchema = z
  .object({
    title: z.string().trim().min(3, 'Enter a product title').max(150, 'Keep the title under 150 characters'),
    description: z.string().trim().min(10, 'Describe the product in a few words').max(20000, 'The description is too long'),
    category: z.string().regex(/^[a-f\d]{24}$/i, 'Choose a category'),
    price: z.number().int('Price must be a whole number of Naira').positive('Enter a price'),
    compareAtPrice: z.number().int().positive().optional(),
    images: z
      .array(
        z.object({
          url: z.string().url(),
          publicId: z.string().optional(),
          alt: optionalText(125, 'Keep each photo description under 125 characters'),
        })
      )
      .max(8, 'Up to 8 images')
      .default([]),
    variants: z
      .array(z.object({ name: z.string().trim().min(1), options: z.array(z.string().trim().min(1)).min(1) }))
      .default([]),
    stock: z.number().int().min(0, 'Stock cannot be negative'),
    brand: optionalText(60, 'Keep the brand under 60 characters'),
    sku: optionalText(60, 'Keep the product code under 60 characters'),
    gtin: z
      .string()
      .trim()
      .regex(/^\d{8,14}$/, 'A barcode is 8 to 14 digits')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    tags: z
      .array(z.string().trim().min(1).max(30, 'Keep each tag under 30 characters'))
      .max(15, 'Up to 15 tags')
      .default([])
      .transform((tags) => [...new Set(tags.map((t) => t.toLowerCase()))]),
    details: z
      .array(z.object({ label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(200) }))
      .max(25, 'Up to 25 product details')
      .default([]),
    seoTitle: optionalText(70, 'Keep the search title under 70 characters'),
    seoDescription: optionalText(180, 'Keep the search description under 180 characters'),
    // The web address of the product page. Empty means it is made from the title.
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single dashes only')
      .max(80, 'Keep the web address under 80 characters')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    status: z.enum(['draft', 'active']).default('active'),
  })
  .refine((p) => p.compareAtPrice === undefined || p.compareAtPrice > p.price, {
    path: ['compareAtPrice'],
    message: 'Must be higher than the price',
  })
  .refine((p) => p.status !== 'active' || p.images.length > 0, {
    path: ['images'],
    message: 'Add at least one image before publishing',
  });

module.exports = { productSchema };
