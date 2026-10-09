const app = require('./app');
const connectDb = require('./config/db');
const { port } = require('./config/env');

app.listen(port, () => console.log(`API running on http://localhost:${port}`));

connectDb().catch((err) => {
  console.error('MongoDB connection failed:', err.message);
  console.error('Check MONGODB_URI in api/.env');
});
