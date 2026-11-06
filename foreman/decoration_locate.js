// foreman/decoration_locate.js — THE DECORATION LOCATE: WHERE THE NEAREST BIOME OF A DECORATIVE DYE SOURCE LIES,
// ASKED OF THE SERVER.
//
// A body that cannot find a whitelisted dye source in its sight or the survey book asks the foreman ('decoration_locate',
// custom_api/sector_finder); the foreman runs the server's own `locate biome` from the body's position and answers
// with the nearest. This is knowledge no player in survival has, so it is held to a strict whitelist
// (architect_config DECORATION_LOCATE): only dye sources, only for decoration, never anything
// underground. The list is checked when this file loads, and every ask is checked against it again.
//
// locate(item, from) → { item, found: { biome, x, y, z, distance } | null, reason }
//   found null: `not_whitelisted` (the ask is refused) or `none_found` (the server found none of its biomes).

'use strict';

const { DECORATION_LOCATE, DYES, SURVEY_ORE_ITEM } = require('@thinking/architect_config');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'decoration_locate';
// Biomes under the ground: a locate may never name one.
const UNDERGROUND = /(caves|deep_dark)/;
// "The nearest #minecraft:is_jungle (minecraft:sparse_jungle) is at [676, 70, -2852] (2848 blocks away)"
// "The nearest minecraft:jungle is at [-2844, 70, -612] (2830 blocks away)"
const FOUND_REPLY = /The nearest (\S+)(?: \(([^)]+)\))? is at \[(-?\d+), (~|-?\d+), (-?\d+)\] \((\d+) blocks? away\)/;
const NONE_REPLY = /Could not find/i;

// THE WHITELIST IS CHECKED ONCE, AT LOAD: an entry that is no dye's source, is not for decoration, names an ore, or
// locates a cave biome is a coding violation, never a quiet skip.
for (const [item, entry] of Object.entries(DECORATION_LOCATE)) {
  const dye = Object.values(DYES).find(d => d.dye === entry.dye);
  const fault = !dye || !dye.from.includes(item) ? `${item} is not the source of ${entry.dye} in DYES`
    : entry.reason !== 'decoration' ? `${item}'s reason is '${entry.reason}', not 'decoration'`
    : SURVEY_ORE_ITEM.test(item) ? `${item} is an underground material`
    : !Array.isArray(entry.locate) || !entry.locate.length ? `${item} names no biome to locate`
    : entry.locate.find(b => UNDERGROUND.test(b)) ? `${item} locates an underground biome (${entry.locate.find(b => UNDERGROUND.test(b))})`
    : null;
  if (fault) throw new Error(`[${TAG}] CODING VIOLATION: architect_config DECORATION_LOCATE — ${fault}.`);
}

const whitelisted = item => Object.prototype.hasOwnProperty.call(DECORATION_LOCATE, item);

async function locate(item, from) {
  if (!whitelisted(item)) return { item, found: null, reason: 'not_whitelisted' };
  return nearest(item, DECORATION_LOCATE[item].locate, from);
}

// locateForModule(biome, from) — the walk test module's target (foreman_config `module`): the nearest biome the
// operator named. Answered only while a test module is on, never for a surface the fleet plays on, and never a
// biome under the ground.
async function locateForModule(biome, from) {
  const CONFIG = require('../foreman_config');
  const label = `biome:${biome}`;
  if (CONFIG.module === 'off') return { item: label, found: null, reason: 'no_module' };
  if (!/^[a-z_]+$/.test(String(biome)) || UNDERGROUND.test(biome)) return { item: label, found: null, reason: 'not_a_surface_biome' };
  return nearest(label, [`minecraft:${biome}`], from);
}

async function nearest(item, biomes, from) {
  if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(from.z)) {
    throw new Error(`[${TAG}] CODING VIOLATION: locate needs the body's position. Got: ${JSON.stringify(from)}`);
  }
  const at = `${Math.floor(from.x)} ${Math.floor(from.y)} ${Math.floor(from.z)}`;
  const cmds = biomes.map(b => `execute positioned ${at} run locate biome ${b}`);
  const r = await guardExternal(TAG, `locate ${item}'s biomes`, () => require('@utils/rcon_link').once(cmds));
  if (!r.ok) return { item, found: null, reason: `rcon_failed:${r.reason}` };
  let best = null;
  for (const { cmd, body } of r.value) {
    const m = FOUND_REPLY.exec(body);
    if (m) {
      const y = m[4] === '~' ? Math.floor(from.y) : +m[4];
      const hit = { biome: (m[2] || m[1]).replace(/^minecraft:/, ''), x: +m[3], y, z: +m[5], distance: +m[6] };
      if (!best || hit.distance < best.distance) best = hit;
    } else if (!NONE_REPLY.test(body)) {
      throw new Error(`[${TAG}] the server answered '${cmd}' with neither a place nor none: ${JSON.stringify(body)}`);
    }
  }
  return { item, found: best, reason: best ? 'found' : 'none_found' };
}

module.exports = { locate, locateForModule, whitelisted };
