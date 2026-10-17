const Product = require('../models/Product');
const { getStoreSettings } = require('./storeSettings');

// How many of this vendor's listings the admin has approved. Enough of them and the vendor is "proven".
const approvedCount = (vendorId) => Product.countDocuments({ vendor: vendorId, approvedAt: { $exists: true } });

// Does a new listing, or a change to what customers read or see, need the admin to check it first?
//   - An 18+ product: always.
//   - A vendor the admin marked 'always': yes. Marked 'trusted': no.
//   - Otherwise it follows the store's setting: everyone ('all'), only vendors who are not proven yet ('smart'), or nobody ('none').
// This is how marketplaces balance safety and speed: Jumia checks every listing, eBay limits new sellers until they have a
// record, and Amazon checks risky categories. Price and stock changes are never checked.
async function needsReview(vendor, { ageRestricted = false } = {}) {
  if (ageRestricted) return true;
  if (vendor.listingReview === 'always') return true;
  if (vendor.listingReview === 'trusted') return false;
  const { listingReviewMode, provenAfterApprovals } = await getStoreSettings();
  if (listingReviewMode === 'all') return true;
  if (listingReviewMode === 'none') return false;
  return (await approvedCount(vendor._id)) < provenAfterApprovals;
}

// What the product form tells the vendor about their own listings.
async function reviewStatus(vendor) {
  const { listingReviewMode, provenAfterApprovals } = await getStoreSettings();
  const approved = await approvedCount(vendor._id);
  return {
    // True when an ordinary (not 18+) listing from this vendor would be checked first.
    reviewsNew: await needsReview(vendor),
    mode: listingReviewMode,
    trust: vendor.listingReview,
    approved,
    provenAfter: provenAfterApprovals,
  };
}

module.exports = { needsReview, reviewStatus, approvedCount };
