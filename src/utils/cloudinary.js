const crypto = require('crypto');
const HttpError = require('./httpError');
const { slugify } = require('./slug');

// The browser uploads straight to Cloudinary with this signature, so image bytes never pass through the API.
// `name` (the product title) becomes the start of the photo's file name, e.g. "ankara-shirt-3fa91c", because
// search engines read file names. The name is part of what is signed, so it cannot be changed in the browser.
function signUpload(folder, name) {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = process.env;
  if (!cloudName || !apiKey || !secret) {
    throw new HttpError(503, 'Image uploads are not set up yet. Add the Cloudinary keys to api/.env');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const base = slugify(name ?? '').slice(0, 60);
  const publicId = base ? `${base}-${crypto.randomBytes(3).toString('hex')}` : undefined;

  // Cloudinary signs the parameters in alphabetical order.
  const toSign = [`folder=${folder}`, ...(publicId ? [`public_id=${publicId}`] : []), `timestamp=${timestamp}`].join('&');
  const signature = crypto.createHash('sha1').update(`${toSign}${secret}`).digest('hex');
  return { cloudName, apiKey, timestamp, folder, signature, ...(publicId ? { publicId } : {}) };
}

module.exports = { signUpload };
