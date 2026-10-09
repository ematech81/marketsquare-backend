// Loaded before every test file: turns off rate limiting and keeps real mail settings out of tests.
process.env.NODE_ENV = 'test';
process.env.DISABLE_RATE_LIMIT = '1';
delete process.env.SMTP_HOST;
