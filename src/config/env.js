require('dotenv').config();

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/squaremarket',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
};
