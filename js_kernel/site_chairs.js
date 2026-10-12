'use strict';
// site_chairs — the two conference-room chairs that record an established base, built from one sited row.
//
// ── ONLY THE FOREMAN SETS A POINT (Law 16) ───────────────────────────────────
// This file BUILDS the chairs and writes nothing. The one writer of a location is the foreman's hub
// (`foreman/foreman_hub.js` `lockSite`), which puts these chairs into the fleet's memory before any body is
// spawned; bots receive them in their first broadcast and read them from then on. A bot has no function
// that writes `set_buildspot` — `corporate_headquarters.writeBuildingChair` refuses it — and the hub drops
// any location a bot sends.
//
// It is a pure function, not a method of the hub, for one caller outside the fleet:
// `Auren_Workshop/tools/build_bench.js`, which runs one body with no foreman and authors its test site the
// way a bench authors every scenario. It builds the same chairs here, so the bench and the fleet cannot
// disagree about what a site row looks like (Law 16).

const blueprintRegistry = require('@kernel/blueprint_registry');

// Every voxel of a blueprint: anchors[].voxels + unassigned_voxels, or the legacy flat `voxels`.
function collectAllVoxels(building) {
  const result = [];
  if (Array.isArray(building.anchors)) {
    for (const a of building.anchors) { if (Array.isArray(a.voxels)) result.push(...a.voxels); }
  }
  if (Array.isArray(building.unassigned_voxels)) result.push(...building.unassigned_voxels);
  if (result.length > 0) return result;
  if (Array.isArray(building.voxels)) return building.voxels;
  return [];
}

// siteChairs(row, writer) → { set_buildspot, blueprint_paster }
//
// `row` is the shape the desk's survey hands (`lock_all_buildspots.siteRow`):
//   { blueprint, roomKey, candidate: { transpose_origin:{x,y,z}, footprint, staircase } }
//
// NO ROTATION FIELD: a blueprint has exactly one facing (blueprint_survey's header), so a reader that
// rebuilds world coordinates from this chair (scan, getProtectedBlocks, getWorldAnchors, farmland_site)
// transposes from transpose_origin alone and can only ever land on the footprint the candidate was proven at.
function siteChairs(row, writer) {
  const bc = row && row.candidate && row.candidate.transpose_origin;
  if (!bc || ![bc.x, bc.y, bc.z].every(Number.isFinite)) {
    throw new Error(`[site_chairs] CODING VIOLATION (Law 13): a site row needs candidate.transpose_origin {x,y,z}, got ${JSON.stringify(row)}.`);
  }
  if (typeof row.blueprint !== 'string' || !row.blueprint) {
    throw new Error(`[site_chairs] CODING VIOLATION (Law 13): a site row needs its blueprint name, got ${JSON.stringify(row)}.`);
  }
  if (typeof writer !== 'string' || !writer) {
    throw new Error('[site_chairs] CODING VIOLATION (Law 13): a site is written by someone — name the writer.');
  }
  // A HAND-AUTHORED blueprint is counted from the registry. A downloaded one is not in that registry —
  // downloads never share a file with hand-authored blueprints — so its row carries its own size.
  const hand = blueprintRegistry.tryGetBuilding(row.blueprint);
  const total = hand ? collectAllVoxels(hand).length : row.total_voxels;
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error(`[site_chairs] CODING VIOLATION: blueprint "${row.blueprint}" has no voxels`
      + (hand ? '.' : ' — it is not a hand-authored blueprint and its site row carries no total_voxels.'));
  }
  const now = new Date().toISOString();
  const c = row.candidate;
  return {
    set_buildspot: {
      transpose_origin: { x: bc.x, y: bc.y, z: bc.z },
      footprint: c.footprint || null,
      staircase: c.staircase || null,
      locked_at: now,
      writer,
    },
    blueprint_paster: {
      building_name: row.blueprint,
      confirmed_at: now,
      total_voxels: total,
      writer,
    },
  };
}

module.exports = { siteChairs, collectAllVoxels };
