const { z } = require('zod');

// The product form, shared by the admin and by vendors. `status` is what the person asked for: save as a draft,
// or publish. Vendors' "publish" may land in review first (see routes/vendorProducts.js).
const productSchema = z
  .object({
    title: z.string().trim().min(3, 'Enter a product title'),
    description: z.string().trim().min(10, 'Describe the product in a few words'),
    category: z.string().regex(/^[a-f\d]{24}$/i, 'Choose a category'),
    price: z.number().int('Price must be a whole number of Naira').positive('Enter a price'),
    compareAtPrice: z.number().int().positive().optional(),
    images: z
      .array(z.object({ url: z.string().url(), publicId: z.string().optional() }))
      .max(8, 'Up to 8 images')
      .default([]),
    variants: z
      .array(z.object({ name: z.string().trim().min(1), options: z.array(z.string().trim().min(1)).min(1) }))
      .default([]),
    stock: z.number().int().min(0, 'Stock cannot be negative'),
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
