'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/site_framing_bench.js');
// bench: site_framing_bench — drive the site camera solver over the saved worlds and print where each
// camera lands. No server, no client, no crew: every world is a voxel snapshot and the castle is sited
// by the fleet's own `surveyFootprint`, so the answer is against real terrain.
//
// WHY IT IS A BENCH AND NOT A ONE-OFF. `camera_configure.sites` holds four numbers that are the
// operator's taste — fill, look-down angle, bearing, canopy clearance — and taste is changed by looking
// at the result and changing a number. That loop needs to run without a world, or it costs a 3-hour
// build per attempt. The flags below override one criterion at a time so two bearings can be compared
// in the same breath; the config page stays the answer and the flags are for the comparison.
//
//   node Auren_Workshop/tools/site_framing_bench.js
//   node Auren_Workshop/tools/site_framing_bench.js --bearing=0        # due north, to compare
//   node Auren_Workshop/tools/site_framing_bench.js --structure=headframe
//
// WHAT `--structure=headframe` DOES AND DOES NOT SAY. It solves the HEADFRAME'S SIZE at the CASTLE'S
// sited position, against that world's real trees. The headframe's own locked spot comes from the
// builder layout, which needs the hub, so this is not a headframe camera — it is the short-structure
// case driven against real terrain, which is the case where the four criteria stop fitting together.
// It is here because a `relaxed` report that has never been produced is a code path nobody has seen.

const paths = require('../workshop_paths');
paths.registerAliases();
const store = require('./voxel_snapshot_store');
const { surveyFootprint } = require('@utils/footprint_survey');
const { BUILDER_BLUEPRINT } = require('@thinking/architect_config');
const { solveSiteCamera } = require('../camera/site_framing');
const CFG = require('../camera/camera_configure');

const argv = process.argv.slice(2);
const KNOWN = new Set(['bearing', 'fill', 'elev', 'structure']);
for (const a of argv) {
  const name = a.replace(/^--/, '').split('=')[0];
  if (!KNOWN.has(name)) {
    console.error(`site_framing_bench: unknown argument ${a}`);
    console.error(`  permitted: --bearing=<deg> --fill=<0..1> --elev=<deg> --structure=castle|headframe`);
    process.exit(2);
  }
}
const opt = (k, d) => { const a = argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const numOpt = (k, d) => { const v = opt(k, null); return v === null ? d : Number(v); };

const STRUCTURE = opt('structure', 'castle');
if (STRUCTURE !== 'castle' && STRUCTURE !== 'headframe') {
  console.error(`site_framing_bench: --structure must be castle or headframe, got ${STRUCTURE}`);
  process.exit(2);
}

// The criteria are the config page's, with one flag allowed to override one of them for a comparison.
// `eyeHeight` is not on the sites block — it is a fact about the CLIENT and already lives in
// `frame`, so it is read from there (Law 16).
const criteria = {
  ...CFG.sites,
  fovDeg: CFG.frame.cone.fovDeg,
  aspect: CFG.frame.cone.aspect,
  eyeHeight: CFG.frame.eyeHeight,
  bearingDeg: numOpt('bearing', CFG.sites.bearingDeg),
  fill: numOpt('fill', CFG.sites.fill),
  elevationDeg: numOpt('elev', CFG.sites.elevationDeg),
};

// The castle's full height is in its imported build plan, not in architect_config (which carries the
// footprint the siting needs). Named here with its source so the number is traceable.
const CASTLE_HEIGHT = 42;
const HEADFRAME = { w: 10, l: 5, height: 6, below: 0 };   // js_kernel/building_blueprints.json

const say = m => console.log(m);
const r1 = n => n.toFixed(1);

say(`\n=== SITE CAMERA — solved against the sited castle on every saved world, no server ===`);
say(`structure   ${STRUCTURE === 'castle'
  ? `${BUILDER_BLUEPRINT.name} ${BUILDER_BLUEPRINT.w}x${BUILDER_BLUEPRINT.l}, ${CASTLE_HEIGHT} tall, ${BUILDER_BLUEPRINT.below} below ground`
  : `headframe ${HEADFRAME.w}x${HEADFRAME.l}, ${HEADFRAME.height} tall — SIZE ONLY, standing at the castle's sited spot`}`);
say(`criteria    fill ${Math.round(criteria.fill * 100)}% · look down ${criteria.elevationDeg}° · bearing ${criteria.bearingDeg}° · clear canopy by ${criteria.canopyPad}`);
say(`lens        ${criteria.fovDeg}° vertical at ${criteria.aspect.toFixed(2)}:1, eye ${criteria.eyeHeight} above feet\n`);

const snaps = store.listSnapshots();
if (!snaps.length) {
  console.error('site_framing_bench: no saved snapshots to solve against. Capture one with voxel_snapshot first.');
  process.exit(1);
}

// Framing consumes the completed paced survey for each saved world.
async function solveSnapshots() {
let solved = 0, relaxedAny = 0;
for (const snap of snaps) {
  const bot = store.loadSnapshot(snap.name);
  const bp = BUILDER_BLUEPRINT;
  const survey = await surveyFootprint(bot, { w: bp.w, l: bp.l, below: bp.below, ring: bp.ring });
  const tier = survey.byTolerance.filter(t => t.tolerance <= bp.maxTolerance).find(t => t.passingPlots > 0);
  const label = snap.header?.label || snap.name;
  if (!tier) {
    say(`── ${label}\n   no ${bp.w}x${bp.l} plot level to ±${bp.maxTolerance} with a dry pit — nothing to film.\n`);
    continue;
  }
  const s = tier.picks.find(p => p.passes);
  const centre = { x: s.centre.x, y: s.h, z: s.centre.z };
  const shot = solveSiteCamera(bot, {
    centre,
    footprint: STRUCTURE === 'castle' ? { w: s.fw, l: s.fl } : { w: HEADFRAME.w, l: HEADFRAME.l },
    height: STRUCTURE === 'castle' ? CASTLE_HEIGHT : HEADFRAME.height,
    below: STRUCTURE === 'castle' ? bp.below : HEADFRAME.below,
    criteria,
  });
  solved++;
  if (shot.relaxed.length) relaxedAny++;

  say(`── ${label}  ·  ${s.biome}`);
  say(`   sited       ${s.fw}x${s.fl} centred (${centre.x},${centre.y},${centre.z}), level to ±${tier.tolerance}`);
  say(`   silhouette  ${r1(shot.silhouette)} wide at this bearing · ${shot.binding} sets the distance`);
  say(`   teleport    (${Math.round(shot.feet.x)}, ${Math.round(shot.feet.y)}, ${Math.round(shot.feet.z)})  facing yaw ${shot.yaw.toFixed(0)} pitch ${shot.pitch.toFixed(0)}`);
  say(`   lens        ${r1(shot.distance)} back, ${r1(shot.lens.y - centre.y)} above the ground floor`);
  say(`   fills       ${Math.round(shot.fill.height * 100)}% of frame height · ${Math.round(shot.fill.width * 100)}% of frame width`);
  say(`   canopy      tallest in the corridor ${shot.canopy.tallestAboveFloor} above the ground floor`);
  say(`   frame holds ${Math.round(shot.groundWidthAtSubject)} blocks of ground across, at the subject's distance`);
  if (shot.relaxed.length) {
    for (const r of shot.relaxed) say(`   RELAXED     ${r.criterion}: asked ${r.asked}, got ${r.got} — ${r.because}`);
  } else {
    say(`   held        all four criteria, nothing relaxed`);
  }
  say('');
}

say(`${solved} world(s) solved · ${relaxedAny} needed a criterion relaxed\n`);
}
solveSnapshots();
