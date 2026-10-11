const crypto = require('crypto');
const HttpError = require('./httpError');

// The browser uploads straight to Cloudinary with this signature, so image bytes never pass through the API.
function signUpload(folder) {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = process.env;
  if (!cloudName || !apiKey || !secret) {
    throw new HttpError(503, 'Image uploads are not set up yet. Add the Cloudinary keys to api/.env');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${secret}`).digest('hex');
  return { cloudName, apiKey, timestamp, folder, signature };
}

module.exports = { signUpload };
