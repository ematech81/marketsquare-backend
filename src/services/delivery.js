const DeliveryZone = require('../models/DeliveryZone');
const Vendor = require('../models/Vendor');

// Who delivers, and what it costs, for one seller and one state.
//   - The store's own products, and vendors who let Square Market deliver: the fees the admin set for each state.
//   - A vendor who delivers their own orders: the fees that vendor set for the states they serve.
// Returns null when this seller does not deliver to the state.
async function quoteForSeller(vendor, state) {
  if (vendor && vendor.deliveryMode === 'self' && !vendor.deliveryLocked) {
    const rate = (vendor.deliveryRates ?? []).find((r) => r.state === state);
    if (!rate) return null;
    return { mode: 'vendor', fee: rate.fee, estimatedDays: rate.estimatedDays ?? 3 };
  }
  const zone = await DeliveryZone.findOne({ state });
  if (!zone) return null;
  return { mode: 'platform', fee: zone.fee, estimatedDays: zone.estimatedDays };
}

// One quote per seller in a cart. `sellers` is a list of vendor ids (null for the store's own products).
async function quoteCart(sellerIds, state) {
  const ids = sellerIds.filter(Boolean);
  const vendors = ids.length ? await Vendor.find({ _id: { $in: ids } }) : [];
  const byId = new Map(vendors.map((v) => [String(v._id), v]));
  const out = [];
  for (const id of sellerIds) {
    const vendor = id ? byId.get(String(id)) : null;
    out.push({ vendor: id ? String(id) : null, name: vendor ? vendor.businessName : 'Square Market', quote: await quoteForSeller(vendor, state) });
  }
  return out;
}

module.exports = { quoteForSeller, quoteCart };
