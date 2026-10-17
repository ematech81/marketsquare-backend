// One order, one tracking. A customer may buy from many vendors, and each vendor's items travel as their own package,
// but the customer should only see ONE order moving along: placed, confirmed, packed, shipped, delivered.
// This works out that single picture from the packages (shipments).

const STAGES = ['placed', 'confirmed', 'packed', 'shipped', 'delivered'];
const LABEL = { placed: 'Order placed', confirmed: 'Order confirmed', packed: 'Packed', shipped: 'Shipped', delivered: 'Delivered' };

const latest = (list) => list.reduce((a, b) => (!a || new Date(b) > new Date(a) ? b : a), null);

// `shipments` are the order's packages. The order is only as far along as its slowest package, so "Shipped" means every
// package is on its way. While some are, `partial` is true and the counts say how many.
function progressOf(shipments) {
  const live = shipments.filter((s) => s.status !== 'cancelled');
  const packages = {
    total: shipments.length,
    live: live.length,
    onTheWay: live.filter((s) => s.status === 'shipped' || s.status === 'delivered').length,
    delivered: live.filter((s) => s.status === 'delivered').length,
  };

  if (shipments.length > 0 && live.length === 0) {
    return { stage: 'cancelled', index: -1, cancelled: true, partial: false, packages, steps: [] };
  }
  if (live.length === 0) {
    // Nothing has been made yet (an order still waiting for payment).
    return { stage: 'placed', index: 0, cancelled: false, partial: false, packages, steps: [] };
  }

  const index = Math.min(...live.map((s) => STAGES.indexOf(s.status)));
  const partial = packages.onTheWay > 0 && packages.onTheWay < live.length;

  const steps = STAGES.map((name, i) => {
    const done = i <= index;
    const times = done && i > 0 ? live.map((s) => s.timeline?.find((t) => t.status === name)?.at).filter(Boolean) : [];
    let note = '';
    if (name === 'shipped' && !done && partial) note = `${packages.onTheWay} of ${live.length} packages are on their way`;
    if (name === 'delivered' && !done && packages.delivered > 0) note = `${packages.delivered} of ${live.length} packages delivered`;
    return {
      name,
      label: LABEL[name],
      done,
      // A step that is under way for some packages but not yet all of them.
      partial: !done && ((name === 'shipped' && partial) || (name === 'delivered' && packages.delivered > 0)),
      at: done ? latest(times) : null,
      note,
    };
  });

  return { stage: STAGES[index], index, cancelled: false, partial, packages, steps };
}

module.exports = { progressOf, STAGES, LABEL };
