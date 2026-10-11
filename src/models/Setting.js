const mongoose = require('mongoose');

// One document (key "store") holding the rules the admin can change in the dashboard.
const settingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  values: { type: mongoose.Schema.Types.Mixed, default: {} },
});

module.exports = mongoose.model('Setting', settingSchema);
