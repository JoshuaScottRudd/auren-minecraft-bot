'use strict';
// Survival lends the body one breath. Water navigation owns planning, step execution and its progress
// verdict; the caller owns its underwater task and cannot retain control after the lease ends.
//
// THE BREATH OVERRIDE. Swimming is a lawful move and the navigator's (navigator.swimStep keeps the head up in open
// water, navigator.treadWater floats a body that waits there). Survival touches the controls only when the air runs
// low: LOW_AIR raises the notice (mode 'notified', survivalHasControl true), the caller's next checkpoint
// (battle_stations.combatCheckpoint) hands the body over, and survival swims it to air, holds it there until the breath
// is full, then releases the controls and the caller's job goes on. A notice no checkpoint answers within GRACE_MS, or
// air down to CRITICAL_AIR, is taken without one. A floating body's controls are never pressed here.
//
// ONE OWNER OF EVERY WAY OUT OF WATER. This unit is the only door to water_escape: the dig-out after a swim found no
// air (rescue, asked by battle_stations' checkpoint), the trapped body's proof and dig (freeTrapped, asked by the
// navigator when no route leaves the water), and the surface swim ashore (ashore). Each holds the body in this one
// state ('escaping'), so the breath tick never starts a swim under an escape and no escape starts under a swim: a
// caller asking while the body is held is refused with 'survival_has_control' and its next checkpoint answers.
const watcher = require('@kernel/watcher');
const water = require('@utils/underwater_pathfinding');
const { guardExternalSync, guardExternal, withCleanup, violation } = require('@utils/external_library_guard');
const { sleep } = require('@utils/fragment_utils');
const TAG='underwater_swimming';
const states=new WeakMap();
const MAX_DIVE_MS=12000, RESERVE_MS=3000, STALL_MS=2500, MAX_REPLANS=3, RECOVERY_MS=20000;
const LOW_AIR=12;        // air (of 20, 0.75 s each) at or under which survival raises the notice
const CRITICAL_AIR=6;    // air at or under which a notice is taken without waiting for the caller's checkpoint
const GRACE_MS=1500;     // how long a notice waits for the caller's checkpoint before survival takes the body anyway

function navigation() {
  return { active:true, generation:0, key:null, goal:null, nextGoal:null, path:null, index:0, searching:false,
    searches:0, replans:0, best:Infinity, progressedAt:Date.now(), phase:'idle', reason:null, penalties:new Map() };
}
function state(bot) {
  if (!states.has(bot)) states.set(bot,{mode:'floating',lease:null,reason:null,pending:false,failed:false,
    nav:navigation(), escape:null, escapeSearch:null, escapeRetries:0, generation:0, surfaceStartedAt:null, notifiedAt:null});
  return states.get(bot);
}
function oxygen(bot) {
  const keys=bot.registry?.entitiesByName?.[bot.entity?.name || 'player']?.metadataKeys;
  const index=keys?.indexOf('air_supply');
  const ticks=index>=0 ? bot.entity?.metadata?.[index] : null;
  // The server sends a body's air only once it changes from full, and the reading stays in the metadata after: no
  // reading yet is full air, under water too (the first ticks of a dive precede the first drop).
  if (!Number.isFinite(ticks)) return bot.entity?.position ? 20 : null;
  return Math.max(0,ticks/15);
}
function breathMs(bot) { const level=oxygen(bot); return level===null ? 0 : Math.max(0,Math.min(20,level)*750-750); }

// ── THE HEAD IS UNDER WHEN THE EYE IS BELOW THE WATER'S OWN SURFACE ──────────────────────────────────────────────
// Water does not fill its cell: a source stands 8/9 of it, a flow of level L (1-7) (8-L)/9, and a falling flow (level 8
// and up) or water with more water over it fills it whole. Minecraft takes air only while the eye is below that line,
// so a body whose eye cell holds a thin flow over its head still breathes. A water plant or a waterlogged block in the
// eye cell reads as a source. EYE_HEIGHT is a standing player's.
const EYE_HEIGHT=1.62;
const isWaterBlock=b=>!!b && (b.name==='water' || b.name==='flowing_water');
function waterSurface(bot,cell) {
  const b=bot.blockAt(cell);
  if (!b) return null;
  const full=isWaterBlock(bot.blockAt(cell.offset(0,1,0))) || water.medium(bot,cell.offset(0,1,0))==='water';
  if (isWaterBlock(b)) {
    const level=require('@utils/gravity_utils').waterLevel(bot,cell.x,cell.y,cell.z) ?? 0;
    return full || level>=8 ? 1 : (8-level)/9;
  }
  if (water.medium(bot,cell)==='water') return full ? 1 : 8/9;
  return 0;
}
function eyeReading(bot) {
  const p=bot.entity?.position;
  if (!p) return null;
  const eyeY=p.y+EYE_HEIGHT;
  const cell=p.offset(0,EYE_HEIGHT,0).floored();
  const surface=waterSurface(bot,cell);
  return { eyeY, cell, surface, eyeAt:eyeY-cell.y, under:surface!==null && eyeY-cell.y<surface };
}
function submerged(bot) { const r=eyeReading(bot); return !!r && r.under; }

// What the body stood in when its air ran low, for the LOW_AIR line: the feet cell, the floor under it, how many
// water cells stand from the feet up, and the eye cell's water.
function sinkingFacts(bot,eye) {
  const feet=bot.entity.position.floored();
  const name=p=>{ const b=bot.blockAt(p); return !b ? 'unloaded' : isWaterBlock(b) ? `water:${require('@utils/gravity_utils').waterLevel(bot,p.x,p.y,p.z) ?? '?'}` : b.name; };
  let column=0;
  for (let y=feet.y; y<feet.y+8 && waterSurface(bot,feet.offset(0,y-feet.y,0)); y++) column++;
  const floor=bot.blockAt(feet.offset(0,-1,0));
  return `eye_cell=(${eye.cell.x},${eye.cell.y},${eye.cell.z}) eye_in=${name(eye.cell)} water_surface=${eye.surface.toFixed(2)} eye_at=${eye.eyeAt.toFixed(2)}`
    +` feet_cell=${name(feet)} floor=${floor ? floor.name : 'unloaded'} standing=${!!(floor && floor.boundingBox==='block')} water_column=${column}`;
}
function clear(bot) { bot.clearControlStates(); }
function cancelNavigation(nav) { nav.active=false; nav.generation++; nav.path=null; nav.penalties.clear(); }
function freshNavigation(s) { cancelNavigation(s.nav); s.nav=navigation(); }
function status(bot) {
  const s=state(bot), n=s.nav, waypoint=n.path?.[n.index];
  return {mode:s.mode,reason:s.reason,expiresAt:s.lease?.expiresAt ?? null,pending:s.pending,
    failed:s.failed,oxygen:oxygen(bot),waypoint:waypoint ? {...waypoint} : null,
    navigation:{phase:n.phase,goal:describeGoal(n.goal),nextGoal:describeGoal(n.nextGoal),remainingSteps:n.path ? n.path.length-n.index : 0,
      searches:n.searches,replans:n.replans,reason:n.reason},returnChecking:!!s.escapeSearch};
}

function describeGoal(goal) {
  return !goal ? null : goal.type==='position' ? {type:goal.type,position:{...goal.position}} : {type:goal.type};
}

// The planner's result stays a claim until the executor checks the route against the current world.
function planNavigation(bot,n,goal) {
  const generation=++n.generation;
  n.searching=true; n.phase='planning'; n.searches++;
  water.findUnderwaterPath(bot,goal,{penalties:n.penalties,cancelled:()=>!n.active || n.generation!==generation})
    .then(result=>{
      if (!n.active || n.generation!==generation) return;
      n.searching=false;
      if (!result.path.length) {
        if (result.reason==='world_changed_during_search' && ++n.replans<=MAX_REPLANS) {
          n.phase='idle'; watcher.summary(TAG,`WATER_REPLAN reason=world_changed_during_search obstruction=${JSON.stringify(result.obstruction)}`);return;
        }
        n.phase='failed'; n.reason=result.reason; return;
      }
      const here=water.feetCell(bot), at=result.path.findIndex(p=>p.equals(here));
      if (at<0 || !water.pathValid(bot,result.path,at)) {
        n.phase=++n.replans<=MAX_REPLANS ? 'idle' : 'failed'; n.reason='body_or_world_moved_during_search'; return;
      }
      n.path=result.path; n.index=Math.min(at+1,result.path.length-1);
      n.best=Infinity; n.progressedAt=Date.now(); n.phase='moving'; n.reason=null;
      watcher.summary(TAG,`WATER_ROUTE goal=${water.goalKey(goal)} cells=${result.path.length} cost_ms=${result.costMs} nodes=${result.expanded} search_ms=${result.elapsedMs}`);
    });
}
function steer(bot,target) {
  const p=bot.entity.position, dx=target.x+0.5-p.x, dz=target.z+0.5-p.z;
  const aimed=guardExternalSync(TAG,'mineflayer look toward swim waypoint',()=>bot.look(Math.atan2(-dx,-dz),0,true));
  if (aimed.ok && aimed.value) guardExternal(TAG,'mineflayer swim look completion',()=>aimed.value);
  if (!aimed.ok) return false;
  bot.setControlState('sprint',false); bot.setControlState('sneak',false);
  bot.setControlState('forward',Math.hypot(dx,dz)>0.12);
  bot.setControlState('jump',target.y+0.18>p.y);
  return true;
}

// One navigation SPA pass: sense the goal and remaining corridor, plan if needed, then execute one
// waypoint. The judge measures waypoint progress, allowing a detour to increase direct target distance.
function navigationStep(bot,n,input) {
  const goal=water.normalizeGoal(input), key=water.goalKey(goal);
  // A moving target updates the next plan after the current atomic step. Replacing a half-completed
  // step on every entity packet can strand the body at its starting cell indefinitely.
  const finishingStep=n.path && n.phase==='moving';
  n.nextGoal=finishingStep && n.key!==key ? goal : null;
  if (n.key!==key && !finishingStep) {
    n.generation++; n.key=key; n.goal=goal; n.path=null; n.searching=false;
    n.phase='idle'; n.reason=null; n.replans=0; n.penalties.clear();
  }
  if (goal.type==='air' && !submerged(bot)) { n.phase='arrived'; clear(bot); return {ok:true,arrived:true}; }
  if (n.phase==='failed') return {ok:false,reason:n.reason};
  if (n.path && !water.pathValid(bot,n.path,Math.max(0,n.index-1))) {
    n.path=null; n.phase='idle'; n.generation++; n.searching=false;
    watcher.summary(TAG,`WATER_REPLAN reason=world_changed goal=${key}`);
  }
  if (!n.path) {
    clear(bot);
    if (!n.searching) planNavigation(bot,n,goal);
    return {ok:true,arrived:false,reason:'planning'};
  }
  const target=n.path[n.index], d=bot.entity.position.distanceTo(water.center(target));
  const p=bot.entity.position;
  // Centering before a turn keeps the full body clear of the corner; depth arrival requires the
  // requested stance, so a surface hover cannot certify a submerged goal.
  if (Math.hypot(p.x-target.x-0.5,p.z-target.z-0.5)<=0.15 && Math.abs(p.y-target.y-0.18)<=0.15) {
    if (n.nextGoal) {
      n.generation++; n.path=null; n.phase='idle'; clear(bot);
      return {ok:true,arrived:false,reason:'target_changed_at_step_boundary'};
    }
    if (n.index===n.path.length-1) { n.phase='arrived'; clear(bot); return {ok:true,arrived:true}; }
    n.index++; n.best=Infinity; n.progressedAt=Date.now();
    clear(bot);
    return {ok:true,arrived:false,reason:'waypoint_reached'};
  }
  if (d<n.best-0.05) { n.best=d; n.progressedAt=Date.now(); }
  if (Date.now()-n.progressedAt>STALL_MS) {
    clear(bot);
    if (++n.replans>MAX_REPLANS) { n.phase='failed'; n.reason='no_progress_after_water_replans'; return {ok:false,reason:n.reason}; }
    const from=n.index ? n.path[n.index-1] : bot.entity.position.floored();
    const edge=`${water.keyOf(from)}>${water.keyOf(target)}`;
    n.penalties.set(edge,(n.penalties.get(edge)||0)+5000);
    n.path=null; n.phase='idle';
    watcher.warn(TAG,`WATER_REPLAN reason=step_stalled goal=${key} attempt=${n.replans}`);
    return {ok:true,arrived:false,reason:'replanning'};
  }
  if (!steer(bot,target)) { n.phase='failed'; n.reason='swim_aim_failed'; return {ok:false,reason:n.reason}; }
  return {ok:true,arrived:false,reason:'moving'};
}

async function requestDive(bot,{durationMs=MAX_DIVE_MS}={}) {
  if (!Number.isFinite(durationMs) || durationMs<=0 || durationMs>MAX_DIVE_MS) throw violation(TAG,`durationMs must be greater than zero and at most ${MAX_DIVE_MS}`);
  const s=state(bot);
  if (s.mode!=='floating' || s.pending) return {ok:false,reason:'survival_has_control'};
  if (!bot.entity?.position || water.medium(bot,water.feetCell(bot))!=='water') return {ok:false,reason:'body_not_in_water'};
  if (oxygen(bot)===null || oxygen(bot)<20) return {ok:false,reason:'breath_not_replenished'};
  const generation=s.generation;
  const escape=await water.findUnderwaterPath(bot,{type:'air'},{maxCostMs:breathMs(bot)-RESERVE_MS,
    cancelled:()=>s.generation!==generation || s.pending});
  if (s.mode!=='floating' || s.pending || s.generation!==generation) return {ok:false,reason:'survival_has_control'};
  if (!escape.path.length || breathMs(bot)<=escape.costMs+RESERVE_MS) return {ok:false,reason:`return_${escape.reason}`};
  if (oxygen(bot)<20) return {ok:false,reason:'breath_not_replenished'};
  const lease=Object.freeze({expiresAt:Date.now()+Math.min(durationMs,breathMs(bot)-escape.costMs-RESERVE_MS)});
  s.lease=lease; s.mode='diving'; s.reason=null; s.failed=false; s.escape=escape; s.escapeRetries=0;
  freshNavigation(s); clear(bot);
  watcher.summary(TAG,`DIVE_GRANTED duration_ms=${lease.expiresAt-Date.now()} oxygen=${oxygen(bot)}`);
  return {ok:true,lease};
}
function beginSurface(bot,reason='work_finished') {
  const s=state(bot);
  if (['surfacing','recovering','blocked'].includes(s.mode)) return;
  s.generation++; s.lease=null; s.mode='surfacing'; s.reason=reason; s.pending=true;
  s.surfaceStartedAt=Date.now();
  s.escape=null; s.escapeSearch=null; freshNavigation(s); clear(bot);
  watcher.summary(TAG,`SURFACE_TAKEOVER reason=${reason} oxygen=${oxygen(bot) ?? 'unknown'}`);
}
function ownsDive(bot,lease) {
  const s=state(bot);
  if (s.mode==='diving' && Date.now()>=s.lease.expiresAt) beginSurface(bot,'dive_expired');
  return s.mode==='diving' && s.lease===lease;
}
// takeControl(bot): the caller's checkpoint hands a notified body to survival (battle_stations). A no-op otherwise.
function takeControl(bot) { if (state(bot).mode==='notified') beginSurface(bot,'low_air'); }
function blocked(bot,reason) {
  const s=state(bot); s.mode='blocked'; s.failed=true; s.reason=reason;
  cancelNavigation(s.nav); clear(bot);
  watcher.warn(TAG,`SURFACE_FAILED reason=${reason} oxygen=${oxygen(bot) ?? 'unknown'} position=${JSON.stringify(bot.entity.position)}`);
}
function checkReturn(bot,s) {
  const here=water.feetCell(bot);
  const at=s.escape?.path.findIndex(p=>p.equals(here)) ?? -1;
  if (at>=0 && water.pathValid(bot,s.escape.path,at)) {
    if (breathMs(bot)<=water.pathCost(s.escape.path,at)+RESERVE_MS) beginSurface(bot,'return_air_reserve');
    return;
  }
  clear(bot);
  if (s.escapeSearch) return;
  const generation=s.generation;
  s.escapeSearch=water.findUnderwaterPath(bot,{type:'air'},{cancelled:()=>s.mode!=='diving' || generation!==s.generation});
  s.escapeSearch.then(result=>{
    if (s.mode!=='diving' || generation!==s.generation) return;
    s.escapeSearch=null;
    if (!result.path.length) {
      if (result.reason==='world_changed_during_search' && ++s.escapeRetries<=MAX_REPLANS) {
        s.escape=null; watcher.summary(TAG,`WATER_RETURN_REPLAN obstruction=${JSON.stringify(result.obstruction)}`);return;
      }
      beginSurface(bot,`return_${result.reason}`); return;
    }
    s.escapeRetries=0;
    s.escape=result;
    if (breathMs(bot)<=result.costMs+RESERVE_MS) beginSurface(bot,'return_air_reserve');
  });
}
// ── TEMPORARY: THE CURRENT REFLEX, until a body swims a current as a priced move ─────────────────────────────────────
// A body in running water is carried: a current can take it over a ravine's lip and out of the falling column it would
// ride down alive. So this unit takes the body the moment
// its feet or eye cell holds running water, the same single owner the breath override is (survivalHasControl holds every
// caller): in a FALLING column it swims up it to a stand, or, with none in reach, rides down centred in it (water takes
// no fall damage), and in any other current, off the ground, it swims ashore (water_escape.ashore). The board posts leave_current alone meanwhile (assessors/current).
const CURRENT_RETRY_MS=1000;   // after an ashore that left the body in the current, before the next is started
// currentAt(bot) → { falling, cell } for the running water at the body's feet or eye, or null when there is none.
function currentAt(bot) {
  const feet=bot.entity.position.floored();
  for (const cell of [feet,feet.offset(0,1,0)]) {
    const level=require('@utils/gravity_utils').waterLevel(bot,cell.x,cell.y,cell.z);
    if (level!==null && level!==0) return {falling:level>=8,cell};
  }
  return null;
}
function inCurrent(bot) { return !!bot.entity?.position && bot.health>0 && !!currentAt(bot); }
// ── SWIM DOWN: the vanilla client's shift in water, which prismarine-physics does not model ──────────────────────────
// Water gravity is gravity/16, so a body holding nothing sinks about 0.5 blocks/s: a 26-tall column outlasts its 15 s
// of air. The vanilla client's LocalPlayer.goDownInWater takes 0.04 off the vertical velocity each tick while shift is
// held in water, about 2.9 blocks/s, so a ride of sixty blocks ends at the foot on its breath.
const SWIM_DOWN_PER_TICK=0.04;
// The push alone, with sneak NOT pressed: prismarine-physics holds a sneaking body that is on the ground from moving off
// its block's edge, so a body resting on a corner over the column could never be steered into it.
function swimDown(bot) {
  if (bot.entity.isInWater) bot.entity.velocity.y-=SWIM_DOWN_PER_TICK;
}
// lipNear(bot) → true when running water within two cells of the body pours over a drop past the fall limit: the body's
// own stand and the four beside it, each asked pathfinding_utils.besideCurrentOverDrop (the search's lip test).
function lipNear(bot) {
  const { besideCurrentOverDrop }=require('@utils/pathfinding_utils');
  const f=bot.entity.position.floored();
  return [[0,0],[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dz])=>besideCurrentOverDrop(bot,f.x+dx,f.y-1,f.z+dz));
}
// onFloor(bot) → the body stands on a full block under its own feet cell. onGround alone is not that: the hitbox is 0.6
// wide, so a body over a column top with its edge on the bank beside it reads onGround with only water under its feet.
function onFloor(bot) {
  if (!bot.entity.onGround) return false;
  const under=bot.blockAt(bot.entity.position.floored().offset(0,-1,0));
  return !!under && under.boundingBox==='block' && under.name!=='water';
}
function currentTick(bot,s) {
  const c=currentAt(bot);
  if (s.mode==='riding') {
    // Out at the column's foot too: standing there the head is still in falling water, and the swim down would hold the
    // body under it until its air ran out. From the foot the body is ashore's.
    if (!c || !c.falling || onFloor(bot)) {
      clear(bot); s.mode='floating'; s.pending=false; s.reason=null;
      watcher.summary(TAG,`CURRENT_RIDDEN out at ${bot.entity.position.floored()}${c && c.falling ? ' (the foot)' : ''} — controls released`);
      if (c) { s.currentRetryAt=0; return currentTick(bot,s); }
      return false;
    }
    // NO SWIM TO AIR FROM A COLUMN: in open air the nearest air is beside the column, where the body falls the rest of
    // the way. The ride goes on to the foot; drowning there is bounded by the column, a fall from it is not.
    const air=oxygen(bot);
    if (air!==null && air<=CRITICAL_AIR && !s.lowAirRiding) {
      s.lowAirRiding=true;
      watcher.warn(TAG,`CURRENT_RIDING_LOW_AIR air=${air.toFixed(1)} at ${bot.entity.position.floored()} — the ride goes on to the foot; air beside a column is a fall`);
    }
    steer(bot,{x:c.cell.x,y:bot.entity.position.y-1,z:c.cell.z});
    swimDown(bot);
    return true;
  }
  if (!c) s.climbTried=false;
  if (s.mode!=='floating' || !c) return false;
  // A FALLING COLUMN IS CLIMBED FIRST. A waterfall is not a way anywhere: the body was going somewhere, so it swims up
  // the column and against the flow to the nearest stand, at or above where the water took it, and goes on from there
  // (water_escape.ashore, its search rising up the column cell by cell, priced against the breath left). Only a safe
  // stand ends the climb: a lip or a lone block beside the column puts the body back over the drop, the column's foot
  // does not. Riding the column down is the stabilizer kept for when no such stand is in reach up it: abnormal, and
  // said as a warning.
  if (c.falling && !onFloor(bot)) {
    if (!s.climbTried) {
      s.climbTried=true;
      watcher.summary(TAG,`CURRENT_CLIMBING falling water at ${c.cell} — swimming up the column and against the flow to the nearest stand`);
      ashore(bot,{withinMs:breathMs(bot)-RESERVE_MS,safeOnly:true}).then(r=>watcher.summary(TAG,`CURRENT_ASHORE ok=${r.ok} reason=${r.reason} swum=${r.swum}${r.stand ? ` stand=(${r.stand.x},${r.stand.y},${r.stand.z})` : ''}`));
      return true;
    }
    s.mode='riding'; s.pending=true; s.reason='falling_water'; s.lowAirRiding=false; clear(bot);
    watcher.warn(TAG,`CURRENT_RIDING falling water at ${c.cell} — no stand in reach up the column; held centred in it to its foot`);
    return true;
  }
  // A body on its feet in a shallow current is left to walk it (current_manager asks ashore), except where the current
  // pours over a drop: standing there, the push walks it over the lip before the board's next sweep.
  // At a column's foot the head is under falling water: ashore too.
  const footOfColumn=c.falling;
  if ((onFloor(bot) && !footOfColumn && !lipNear(bot)) || Date.now()<(s.currentRetryAt||0)) return false;
  s.currentRetryAt=Date.now()+CURRENT_RETRY_MS;
  watcher.summary(TAG,`CURRENT_TAKEN running water at ${c.cell} — swimming ashore`);
  ashore(bot).then(r=>watcher.summary(TAG,`CURRENT_ASHORE ok=${r.ok} reason=${r.reason} swum=${r.swum}${r.stand ? ` stand=(${r.stand.x},${r.stand.y},${r.stand.z})` : ''}`));
  return true;
}

function tick(bot) {
  if (!bot.entity?.position || bot.health<=0) return;
  const s=state(bot);
  // An escape this unit runs is the body's way to air: the tick neither notices nor swims under it.
  if (s.mode==='escaping') return;
  if (currentTick(bot,s)) return;
  if (s.mode==='diving') {
    if (Date.now()>=s.lease.expiresAt) beginSurface(bot,'dive_expired');
    else checkReturn(bot,s);
    if (s.mode==='diving') return;
  }
  // ── LOW AIR: THE NOTICE ──
  // Only the air running low is survival's business. A head that bobs under and comes up again is the navigator's.
  if (s.mode==='floating') {
    const eye=eyeReading(bot), air=oxygen(bot);
    if (eye && eye.under && air!==null && air<=LOW_AIR) {
      s.mode='notified'; s.pending=true; s.notifiedAt=Date.now(); s.reason='low_air';
      watcher.summary(TAG,`LOW_AIR air=${air.toFixed(1)} ${sinkingFacts(bot,eye)}`);
    }
  }
  if (s.mode==='notified') {
    const air=oxygen(bot);
    if (!submerged(bot) && air!==null && air>LOW_AIR) {
      // The caller brought the head up itself (its own swim reached air): the notice is withdrawn.
      s.mode='floating'; s.pending=false; s.notifiedAt=null; s.reason=null;
      watcher.summary(TAG,`LOW_AIR_CLEARED air=${air.toFixed(1)}`);
    } else if (air!==null && air<=CRITICAL_AIR) beginSurface(bot,'critical_air');
    else if (Date.now()-s.notifiedAt>=GRACE_MS) beginSurface(bot,'low_air_unanswered');
    else return;
  }
  if (s.mode==='surfacing') {
    if (Date.now()-s.surfaceStartedAt>=RECOVERY_MS) { blocked(bot,'surface_recovery_deadline');return; }
    const step=navigationStep(bot,s.nav,{type:'air'});
    if (!step.ok) { blocked(bot,step.reason); return; }
    if (step.arrived) {
      s.mode='recovering'; watcher.summary(TAG,`SURFACE_REACHED oxygen=${oxygen(bot) ?? 'unknown'}`);
    } else return;
  }
  // ── HELD AT AIR UNTIL THE BREATH IS FULL, THEN RELEASED ──
  if (s.mode==='recovering') {
    if (oxygen(bot)>=20) {
      clear(bot); s.mode='floating'; s.pending=false; s.notifiedAt=null;
      watcher.summary(TAG,`BREATH_RESTORED oxygen=${oxygen(bot)} reason=${s.reason} — controls released`);
      return;
    }
    bot.setControlState('forward',false);
    bot.setControlState('jump',!!bot.entity.isInWater);
  }
  // 'blocked' presses nothing: the dig-out (rescue) takes the body's way out from there.
}
async function waitForSurface(bot) {
  takeControl(bot);
  const end=Date.now()+RECOVERY_MS;
  while (['surfacing','recovering'].includes(state(bot).mode) && Date.now()<end && bot.health>0) await sleep(50);
  if (['surfacing','recovering'].includes(state(bot).mode)) blocked(bot,'surface_recovery_deadline');
  // Reached means survival held the body at air to full breath and let go; a body in deep water starts sinking the
  // moment it is released, so the head's place now is not the answer.
  return !state(bot).failed && bot.health>0;
}

// ── THE ESCAPES: one at a time, held in this unit's own state ─────────────────────────────────────────────────────
const RISE_MS=2000;   // how long a body escaped from water holds jump to bring its head up before breath is judged

// holding(bot, work) → work()'s result, with the body held as 'escaping' for its length and released to floating after
// (a body still under with its air low is noticed again by the next tick).
async function holding(bot,why,work) {
  const s=state(bot);
  s.generation++; s.lease=null; s.mode='escaping'; s.pending=true; s.reason=why;
  s.escape=null; s.escapeSearch=null; freshNavigation(s); clear(bot);
  return withCleanup(TAG,`water escape: ${why}`,work,()=>{
    const now=state(bot);
    if (now.mode==='escaping') { clear(bot); now.mode='floating'; now.pending=false; now.notifiedAt=null; now.failed=false; }
  });
}
const busy=s=>s.mode==='escaping' || (s.pending && s.mode!=='notified' && s.mode!=='blocked');

// digOut(bot, proof) → true once the body breathes again: water_escape's fewest-dig way to a cell where it stands with
// its head dry. THE ESCAPE ENDS AT THE TOP OF A BOB: in water two deep its "head dry" can be read as the body rises and
// it sinks again before breath is judged, so it swims up (jump held) for RISE_MS before it is judged.
async function digOut(bot,proof) {
  const at=bot.entity.position.floored();
  const protectedBlocks=require('@locomotion/navigator').loadProtectedBlocks(bot);
  const out=await require('@utils/movement/water_escape').escape(bot,{proof,protectedBlocks});
  if (out.escaped && bot.health>0 && submerged(bot)) {
    await withCleanup(TAG,'rise after the water escape',async()=>{
      const until=Date.now()+RISE_MS;
      bot.setControlState('jump',true);
      while (Date.now()<until && bot.health>0 && submerged(bot)) await sleep(50);
    },()=>bot.setControlState('jump',false));
  }
  const breathing=out.escaped && bot.health>0 && !submerged(bot);
  watcher.warn(TAG,`WATER_RESCUE escaped=${breathing} digs=${out.digs} moves=${out.steps} reason=${out.reason || 'head_dry'} from=(${at.x},${at.y},${at.z})`);
  return breathing;
}

// rescue(bot) → true once the body breathes: the low-air notice answered at the caller's checkpoint (battle_stations).
// The swim to air first; NO SWIM REACHES AIR (a flooded tunnel, a pocket with stone on every side): the body digs its own
// way out, the swim's failed search to air being the proof that no ordinary move reaches it.
async function rescue(bot) {
  let surfaced=await waitForSurface(bot);
  if (!surfaced && bot.health>0) {
    const s=state(bot), at=bot.entity.position.floored();
    const proof=`swim survival found no water route to air (${s.reason}) oxygen=${oxygen(bot) ?? '?'} at (${at.x},${at.y},${at.z})`;
    surfaced=await holding(bot,'dig_out',()=>digOut(bot,proof));
    if (surfaced) return true;
    blocked(bot,`dig_out_failed:${s.reason}`);
    return false;
  }
  if (surfaced) acknowledge(bot);
  return surfaced;
}

// freeTrapped(bot, { stopFlow, searchTo, protectedBlocks }) → { escaped, reason }: the navigator's body with no route out
// of water. Refused while this unit holds the body; otherwise held while water_escape proves it trapped and digs.
async function freeTrapped(bot,{stopFlow,searchTo,protectedBlocks}) {
  const s=state(bot);
  if (busy(s) || s.mode==='notified') return {escaped:false,reason:'survival_has_control'};
  return holding(bot,'trapped',async()=>{
    const waterEscape=require('@utils/movement/water_escape');
    const verdict=await waterEscape.prove(bot,{stopFlow,searchTo});
    if (!verdict.trapped) return {escaped:false,reason:'not_trapped'};
    const out=await waterEscape.escape(bot,{proof:verdict.proof,protectedBlocks});
    return {escaped:!!out.escaped,reason:out.reason || null};
  });
}

// ashore(bot) → water_escape.ashore's { ok, reason, stand, swum }: a job's swim to the nearest bank, held here so the
// breath tick does not swim under it. Refused while this unit holds the body.
async function ashore(bot,opts) {
  const s=state(bot);
  if (busy(s) || s.mode==='notified') return {ok:false,reason:'survival_has_control',stand:null,swum:0};
  return holding(bot,'ashore',()=>require('@utils/movement/water_escape').ashore(bot,opts));
}
function escaping(bot) { return state(bot).mode==='escaping'; }

function acknowledge(bot) { const s=state(bot); if (s.mode!=='notified') s.pending=false; }
function survivalHasControl(bot) { return state(bot).pending; }
function reset(bot) {
  const s=state(bot); s.generation++; cancelNavigation(s.nav); s.mode='stopped';
  clear(bot); states.delete(bot);
}
function moveToward(bot,lease,target) {
  if (!ownsDive(bot,lease)) return {ok:false,reason:state(bot).reason || 'dive_revoked'};
  const s=state(bot);
  if (s.escapeSearch) return {ok:true,arrived:false,reason:'checking_return_route'};
  return navigationStep(bot,s.nav,{type:'position',position:target});
}
async function swimTo(bot,lease,target) {
  while (ownsDive(bot,lease)) {
    const step=moveToward(bot,lease,target);
    if (!step.ok) return step;
    if (step.arrived) return {ok:true,reason:'arrived'};
    await sleep(50);
  }
  return {ok:false,reason:state(bot).reason || 'dive_revoked'};
}
async function withDive(bot,options,work) {
  if (typeof work!=='function') throw violation(TAG,'withDive needs an underwater work function');
  const grant=await requestDive(bot,options);
  if (!grant.ok) return grant;
  let surfaced=false;
  const result=await withCleanup(TAG,'borrowed breath',()=>work(grant.lease),async()=>{
    beginSurface(bot); surfaced=await waitForSurface(bot); if (surfaced) acknowledge(bot);
  });
  return {...result,surfaced,ok:!!result.ok && surfaced};
}
module.exports={tick,status,requestDive,ownsDive,beginSurface,takeControl,waitForSurface,moveToward,survivalHasControl,
  acknowledge,reset,swimTo,withDive,submerged,rescue,freeTrapped,ashore,escaping,inCurrent};
