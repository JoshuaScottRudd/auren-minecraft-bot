// calculator: cane_critical_mass — how many cane fields grow the build's sugar cane in CANE_CRITICAL_MASS.hours?
//
// The build's cane is its paper (books for its bookshelves and lecterns), read off the whole plan before any of it stands,
// so the fields are sited up front, their footprints reserved before the tree farm is planted round the base.
//   cane        the build's sugar cane: the plan's every block walked back to its roots (downloaded_plan_registry.blockCounts,
//               build_material_calculator.familyBalance), family sugar_cane
//   per field   the cane one field grows in the hours: its design's crop slots (farmland_site.fieldCellsAt), each plant
//               about one block every grow_minutes
//   fields      ⌈cane × (1 + margin) ÷ per field⌉, at least one and at most fields_max
// A crew whose build carries no cane, or that raises no build, sites the one field.

'use strict';

const _answers = new Map();   // crew → its answer

// caneCriticalMass(crew) → { fields, keys, cane, per_field, capped }: the cane fields to site and their room keys
// (FARM_FIELD.cane, then its copies in order).
function caneCriticalMass(crew) {
  if (_answers.has(crew)) return _answers.get(crew);
  const { FARM_FIELD, CANE_CRITICAL_MASS, CREW_BUILD } = require('@thinking/architect_config');
  const plants = require('@perception/farmland_site').fieldCellsAt(FARM_FIELD.cane, { x: 0, y: 0, z: 0 }).growingSlots.size;
  if (!(plants > 0)) throw new Error(`[cane_critical_mass] CODING VIOLATION (Law 13): the field design '${FARM_FIELD.cane}' grows no plant.`);
  const perField = Math.floor(plants * CANE_CRITICAL_MASS.hours * 60 / CANE_CRITICAL_MASS.grow_minutes);
  const build = CREW_BUILD[crew] || null;
  let cane = 0;
  if (build) {
    const plans = require('@kernel/downloaded_plan_registry');
    plans.load(build);
    const { familyBalance } = require('@utils/calculators/build_material_calculator');
    cane = familyBalance(plans.blockCounts(), {}).sugar_cane?.need || 0;
  }
  const wanted = Math.max(1, Math.ceil(cane * (1 + CANE_CRITICAL_MASS.margin) / perField));
  const fields = Math.min(wanted, CANE_CRITICAL_MASS.fields_max);
  const copies = FARM_FIELD.copies.filter(k => FARM_FIELD.copyOf[k] === FARM_FIELD.cane);
  const answer = Object.freeze({
    fields, keys: Object.freeze([FARM_FIELD.cane, ...copies.slice(0, fields - 1)]), cane, per_field: perField, capped: wanted > fields,
  });
  _answers.set(crew, answer);
  return answer;
}

module.exports = { caneCriticalMass };
