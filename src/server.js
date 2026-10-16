const app = require('./app');
const connectDb = require('./config/db');
const { port } = require('./config/env');

app.listen(port, () => console.log(`API running on http://localhost:${port}`));

// Every 10 minutes: vendor earnings whose protection period is over become available for payout.
const { releaseDueEarnings } = require('./services/wallet');
setInterval(() => {
  releaseDueEarnings().catch((err) => console.error('Releasing earnings failed:', err.message));
}, 10 * 60 * 1000).unref();

connectDb().catch((err) => {
  console.error('MongoDB connection failed:', err.message);
  console.error('Check MONGODB_URI in api/.env');
});
