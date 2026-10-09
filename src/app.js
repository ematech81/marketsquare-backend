const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { clientUrl } = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

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
app.use('/api', require('./routes/catalog'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
