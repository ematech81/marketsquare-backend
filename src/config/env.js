require('dotenv').config();

module.exports = {
  // Items in an order must add up to at least this much (Naira). 0 means no minimum.
  minOrderAmount: Number(process.env.MIN_ORDER_AMOUNT) || 0,
  // Customers can return an item within this many days of delivery.
  returnDays: Number(process.env.RETURN_DAYS) || 30,
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/squaremarket',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  // Where customers land after paying. Defaults to the first CLIENT_URL entry.
  webUrl: process.env.WEB_URL || (process.env.CLIENT_URL || 'http://localhost:3000').split(',')[0].trim(),
};
