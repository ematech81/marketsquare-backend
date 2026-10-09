const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/env');

const signToken = (user) => jwt.sign({ sub: user._id.toString() }, jwtSecret, { expiresIn: '7d' });

module.exports = { signToken };
