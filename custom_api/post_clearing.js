// api: post_clearing
// purpose: the felling half of a spawn-proofing trip: once a trip's posts stand, its body fells every trunk within
//          BASE_LIGHTS.clear_radius of each post, so placing and clearing are one job. Same census (shared.standingSiteTrees)
//          and felling primitive (tree_feller.fell) as a site clear (Law 16). A trunk it cannot fell is said and left: the
//          post stands, and nothing waits on the tree.

'use strict';

const watcher = require('@kernel/watcher');

const TAG = 'post_clearing';

async function clearAroundPosts(bot, anchorIndices) {
  const { BASE_LIGHTS, SPAWN_PROOFING } = require('@thinking/architect_config');
  const site = require('@kernel/corporate_headquarters').readBuildingChair(SPAWN_PROOFING, 'set_buildspot');
  const { torches } = require('@kernel/base_layout').proofingTorches(site);
  const { standingSiteTrees, freeSiteTrees } = require('@thinking/assessors/shared');
  const r = BASE_LIGHTS.clear_radius;
  const box = { min_dx: -r, max_dx: r, min_dz: -r, max_dz: r };
  let felled = 0, left = 0;
  for (const ai of anchorIndices) {
    const at = torches[ai];
    for (;;) {
      const free = freeSiteTrees(await standingSiteTrees(bot, at, box) || []);
      if (!free.length) break;
      const d = (p) => Math.hypot(p.x - at.x, p.z - at.z);
      const target = free.sort((a, b) => d(a) - d(b))[0];
      const res = await require('@api/tree_feller').fell(bot, target, {
        canopyZone: { mode: 'inside', center: { x: at.x, z: at.z }, box },
        preferNear: at,
      });
      if (!res || !res.success) {
        left += free.length;
        watcher.summary(TAG, `POST_CLEAR_LEFT post=${at.x},${at.y},${at.z} trunks=${free.length} reason=${res?.reason || 'unknown'}`);
        break;
      }
      felled++;
    }
  }
  watcher.summary(TAG, `POST_CLEAR posts=${anchorIndices.length} felled=${felled} left=${left} radius=${r}`);
  return { felled, left };
}

module.exports = { clearAroundPosts };
