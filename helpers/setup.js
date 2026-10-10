// Loaded before every test file. Tests must NEVER talk to real services or use the real store rules,
// so every provider setting from the real .env is blanked here (dotenv does not override values already set).
process.env.NODE_ENV = 'test';
process.env.DISABLE_RATE_LIMIT = '1';
for (const key of [
  'BREVO_API_KEY', 'SMTP_HOST', 'SMS_PROVIDER', 'BULKSMS_API_TOKEN', 'BULKSMS_SENDER_ID',
  'ADMIN_ALERT_EMAIL', 'ADMIN_ALERT_PHONE', 'KORAPAY_PUBLIC_KEY', 'KORAPAY_SECRET_KEY',
  'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'ROUTER_FORWARD_SECRET',
]) {
  process.env[key] = '';
}
process.env.MIN_ORDER_AMOUNT = '0';
process.env.MONGODB_URI = ''; // tests use their own in-memory database, never Atlas
