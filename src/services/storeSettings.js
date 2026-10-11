const Setting = require('../models/Setting');

// The rules the admin can change in the dashboard. These are the starting values.
const DEFAULTS = {
  // Share of each vendor sale kept by Square Market, in percent. A vendor can have their own rate instead.
  defaultCommissionRate: 10,
  // The smallest amount a vendor can ask to be paid out (Naira).
  minPayoutAmount: 10000,
  // When true, a vendor's new or changed listing is checked by the admin before it goes live.
  requireListingApproval: true,
};

async function getStoreSettings() {
  const doc = await Setting.findOne({ key: 'store' });
  return { ...DEFAULTS, ...(doc?.values ?? {}) };
}

async function saveStoreSettings(values) {
  const next = { ...(await getStoreSettings()), ...values };
  await Setting.findOneAndUpdate({ key: 'store' }, { values: next }, { upsert: true });
  return next;
}

module.exports = { getStoreSettings, saveStoreSettings, DEFAULTS };
