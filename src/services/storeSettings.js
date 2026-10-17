const Setting = require('../models/Setting');

// The rules the admin can change in the dashboard. These are the starting values.
const DEFAULTS = {
  // Share of each vendor sale kept by Square Market, in percent. A vendor can have their own rate instead.
  defaultCommissionRate: 10,
  // The smallest amount a vendor can ask to be paid out (Naira).
  minPayoutAmount: 10000,
  // When true, a vendor's new or changed listing is checked by the admin before it goes live.
  requireListingApproval: true,
  // Who gets their listings checked by the admin before they go live (the way Jumia and Konga do it):
  //   'all'   every vendor, every new listing and every change to what customers read or see (the default)
  //   'smart' vendors who are not proven yet (fewer than provenAfterApprovals approved listings)
  //   'none'  nobody (an 18+ product is always checked)
  listingReviewMode: 'all',
  provenAfterApprovals: 3,
  // Pay on delivery: customers may choose it at checkout, for orders up to this total (Naira).
  codEnabled: true,
  codMaxAmount: 100000,
  // After an order is delivered, the vendor's earnings wait this many days before they can be paid out. During this
  // time the customer can report a problem. (Amazon does the same: money is released a week after confirmed delivery.)
  payoutHoldDays: 7,
  // A vendor's first 3 deliveries wait this many extra days, while they have no track record.
  newVendorExtraHoldDays: 7,
};

async function getStoreSettings() {
  const doc = await Setting.findOne({ key: 'store' });
  const values = doc?.values ?? {};
  const settings = { ...DEFAULTS, ...values };
  // A store that saved "do not check products" before there were review modes means 'none'.
  if (values.listingReviewMode === undefined && values.requireListingApproval === false) settings.listingReviewMode = 'none';
  return settings;
}

async function saveStoreSettings(values) {
  const next = { ...(await getStoreSettings()), ...values };
  await Setting.findOneAndUpdate({ key: 'store' }, { values: next }, { upsert: true });
  return next;
}

module.exports = { getStoreSettings, saveStoreSettings, DEFAULTS };
