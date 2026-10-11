const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { clientUrl } = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
// Behind Railway or another proxy, so rate limits see the real visitor address.
app.set('trust proxy', 1);

app.use(helmet());
// CLIENT_URL can list several origins (storefront and dashboard), separated by commas.
app.use(cors({ origin: clientUrl.split(',').map((o) => o.trim()), credentials: true }));
app.use(morgan('dev'));
app.use(express.json());

app.use('/api/health', require('./routes/health'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin', require('./routes/adminCatalog'));
app.use('/api/admin', require('./routes/adminOverview'));
app.use('/api/admin', require('./routes/adminOrders'));
app.use('/api/admin', require('./routes/adminCustomers'));
app.use('/api/admin', require('./routes/adminVendorTools'));
app.use('/api/vendor', require('./routes/vendorProducts'));
app.use('/api/vendor', require('./routes/vendorOrders'));
app.use('/api/vendor', require('./routes/vendorWallet'));
app.use('/api', require('./routes/settings'));
app.use('/api', require('./routes/stores'));
app.use('/api', require('./routes/reviews'));
app.use('/api', require('./routes/catalog'));
app.use('/api', require('./routes/delivery'));
app.use('/api/cart', require('./routes/cart'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/webhooks', require('./routes/webhooks'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
