'use strict';
// site_chairs — the two conference-room chairs that say "a base is established here", built from one sited row.
//
// ── ONLY THE FOREMAN SETS A POINT (Architect 2026-09-18) ────────────────────────────────────────────
// *"Continue combining and law 16. Bots can't set their own points now"*
//
// This file BUILDS the chairs and writes nothing. The one writer of a location is the foreman's hub
// (`foreman/foreman_hub.js` `lockSite`), which puts these chairs into the fleet's memory before any body is
// spawned; bots receive them in their first broadcast and read them from then on. A bot has no function
// that writes `set_buildspot` — `corporate_headquarters.writeBuildingChair` refuses it — and the hub drops
// any location a bot sends.
//
// It is a pure function rather than a method of the hub for one caller outside the fleet:
// `Auren_Workshop/tools/build_bench.js`, which runs one body with no foreman and AUTHORS its test site the way
// a bench authors every scenario. It builds the same chairs here, so the bench and the fleet cannot come to
// disagree about what a site row looks like (Law 16).
//
// Replaces `action_fragments.js/set_buildspot.js` `lock()`, deleted 2026-09-18 with the bot-side write.

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
//   { blueprint, roomKey, candidate: { build_center:{x,y,z}, footprint, staircase, rotation } }
//
// ROTATION IS CARRIED, NOT DEFAULTED AWAY: every reader that rebuilds world coordinates from this chair
// (scan, getProtectedBlocks, getWorldAnchors, farmland_site) must apply the rotation the candidate was proven
// safe at, or it rebuilds against a footprint nobody validated.
function siteChairs(row, writer) {
  const bc = row && row.candidate && row.candidate.build_center;
  if (!bc || ![bc.x, bc.y, bc.z].every(Number.isFinite)) {
    throw new Error(`[site_chairs] CODING VIOLATION (Law 13): a site row needs candidate.build_center {x,y,z}, got ${JSON.stringify(row)}.`);
  }
  if (typeof row.blueprint !== 'string' || !row.blueprint) {
    throw new Error(`[site_chairs] CODING VIOLATION (Law 13): a site row needs its blueprint name, got ${JSON.stringify(row)}.`);
  }
  if (typeof writer !== 'string' || !writer) {
    throw new Error('[site_chairs] CODING VIOLATION (Law 13): a site is written by someone — name the writer.');
  }
  const voxels = collectAllVoxels(blueprintRegistry.getBuilding(row.blueprint, 'site_chairs'));
  if (voxels.length === 0) {
    throw new Error(`[site_chairs] CODING VIOLATION: blueprint "${row.blueprint}" has no voxels.`);
  }
  const now = new Date().toISOString();
  const c = row.candidate;
  return {
    set_buildspot: {
      build_center: { x: bc.x, y: bc.y, z: bc.z },
      footprint: c.footprint || null,
      staircase: c.staircase || null,
      rotation: c.rotation ?? 0,
      locked_at: now,
      writer,
    },
    blueprint_paster: {
      building_name: row.blueprint,
      confirmed_at: now,
      total_voxels: voxels.length,
      writer,
    },
  };
}

module.exports = { siteChairs, collectAllVoxels };
