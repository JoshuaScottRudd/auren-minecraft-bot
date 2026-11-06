// calculator: wheat_critical_mass — how many wheat fields grow, in ONE harvest, the wheat that breeds every pen full?
//
// Wheat is eaten as fast as the pens breed, so the crew does not grow it up over time as it grows cane: it sites enough
// fields that one harvest of them all carries the whole breeding (architect_config.WHEAT_CRITICAL_MASS).
//   per field   the plants one field grows: its design's crop slots (farmland_site.fieldCellsAt), half its ground,
//               every other row left open so no row slows the next.
//   per pen     the pen breeds from its first pair to its flock (pen_gate.flockOf): each young costs two wheat, one per
//               parent, so 2 × (flock − HERDING.breed_pair_min).
//   reserve     HERDING.herders: the wheat a herd holds in hand to lead the first pair in.
//   fields      ⌈(pens + reserve) × (1 + margin) ÷ per field⌉, at least one and at most fields_max.
// Every number is read off the blueprints and the config, so the answer is the same before any site is chosen.

'use strict';

let _answer = null;

// wheatCriticalMass() → { fields, keys, wheat, per_field, pens: [{ pen, flock, wheat }], reserve, capped }: the fields
// to site and their room keys (FARM_FIELD.structure, then its copies in order).
function wheatCriticalMass() {
  if (_answer) return _answer;
  const { FARM_FIELD, FARM_PENS, HERDING, WHEAT_CRITICAL_MASS } = require('@thinking/architect_config');
  const origin = { x: 0, y: 0, z: 0 };
  const perField = require('@perception/farmland_site').fieldCellsAt(FARM_FIELD.design, origin).growingSlots.size;
  if (!(perField > 0)) throw new Error(`[wheat_critical_mass] CODING VIOLATION (Law 13): the field design '${FARM_FIELD.design}' grows no plant.`);
  const { penAt, penGeometry, flockOf } = require('@api/pen_gate');
  const pens = FARM_PENS.map(pen => {
    const flock = flockOf(penGeometry(penAt(pen, origin)));
    return { pen, flock, wheat: 2 * Math.max(0, flock - HERDING.breed_pair_min) };
  });
  const reserve = HERDING.herders;
  const wheat = pens.reduce((n, p) => n + p.wheat, 0) + reserve;
  const wanted = Math.max(1, Math.ceil(wheat * (1 + WHEAT_CRITICAL_MASS.margin) / perField));
  const fields = Math.min(wanted, WHEAT_CRITICAL_MASS.fields_max);
  _answer = Object.freeze({
    fields, keys: Object.freeze([FARM_FIELD.structure, ...FARM_FIELD.copies.filter(k => FARM_FIELD.copyOf[k] === FARM_FIELD.structure).slice(0, fields - 1)]),
    wheat, per_field: perField, pens, reserve, capped: wanted > fields,
  });
  return _answer;
}

// fieldKeysSited(crew) → every FARM_FIELD key the crew sites: the water pool, the wheat fields critical mass asks for,
// and the cane fields cane critical mass asks for (calculators/cane_critical_mass).
function fieldKeysSited(crew) {
  const { FARM_FIELD } = require('@thinking/architect_config');
  const sited = new Set([FARM_FIELD.pool, ...wheatCriticalMass().keys, ...require('@utils/calculators/cane_critical_mass').caneCriticalMass(crew).keys]);
  return FARM_FIELD.keys.filter(k => sited.has(k));
}

module.exports = { wheatCriticalMass, fieldKeysSited };
