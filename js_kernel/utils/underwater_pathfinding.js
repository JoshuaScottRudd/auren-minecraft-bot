'use strict';
// The water graph uses feet cells, three-dimensional clearance and swim time.
// Ground movement, terrain alteration and its floor graph have no edges here.
const Vec3 = require('vec3');
const { MinHeap } = require('./min_heap');
const { waterLevel } = require('./gravity_utils');
const { isNotSafeSurface, isHazardBeside } = require('./movement/terrain_predicates');
const { makeExecutionPacer } = require('./execution_yield');
const memory = require('./memory_workspace');
const { guardExternalSync, violation } = require('./external_library_guard');

const AIR = new Set(['air','cave_air','void_air']);
const WATER_PLANTS = new Set(['kelp','kelp_plant','seagrass','tall_seagrass']);
const EDGES = [[0,1,0,1000],[1,0,0,1000],[-1,0,0,1000],[0,0,1,1000],[0,0,-1,1000],[0,-1,0,2500]];
// RUNNING WATER IS SWUM, AT A PRICE: a body in it must be able to move through it and out, yet a route through it is
// taken only when still water does not serve. Each running cell entered costs FLOW_MS on top of its move.
const FLOW_MS = 3000;
const keyOf = p => `${p.x},${p.y},${p.z}`;
const center = p => p.offset(0.5,0.18,0.5);
function feetCell(bot) {
  const p=bot.entity.position.floored();
  return medium(bot,p)==='air' && medium(bot,p.offset(0,-1,0))==='water' ? p.offset(0,-1,0) : p;
}

function medium(bot,p) {
  const b = bot.blockAt(p);
  if (!b) return null;
  if (AIR.has(b.name)) return 'air';
  if (b.shapes?.length || b.boundingBox !== 'empty') return null;
  if (waterLevel(bot,p.x,p.y,p.z) !== null || WATER_PLANTS.has(b.name)) return 'water';
  const properties = guardExternalSync('underwater_pathfinding','read block waterlogging',() => b.getProperties());
  return properties.ok && properties.value?.waterlogged === true ? 'water' : null;
}
function running(bot,p) { return (waterLevel(bot,p.x,p.y,p.z) ?? 0) > 0; }
function canOccupy(bot,p) {
  if (medium(bot,p) !== 'water' || medium(bot,p.offset(0,1,0)) === null) return false;
  const below = p.offset(0,-1,0);
  if (medium(bot,below) !== 'water' && isNotSafeSurface(bot.blockAt(below))) return false;
  for (const [dx,,dz] of EDGES.slice(1,5)) for (const dy of [0,1]) {
    const q = p.offset(dx,dy,dz);
    if (medium(bot,q) === null && isHazardBeside(bot.blockAt(q))) return false;
  }
  return true;
}
// The cell at `from` is where the body is: it is never judged, only the cells it moves into. A body standing in a
// cell no swim would enter (a plant with water over it) still leaves it.
function pathValid(bot,path,from=0) {
  for (let i=from;i<path.length;i++) {
    if (i>from && !canOccupy(bot,path[i])) return false;
    if (i>from && Math.abs(path[i].x-path[i-1].x)+Math.abs(path[i].y-path[i-1].y)+Math.abs(path[i].z-path[i-1].z)!==1) return false;
  }
  return true;
}
function pathCost(path,from=0) {
  let ms=1000;
  for (let i=from+1;i<path.length;i++) ms += path[i].y<path[i-1].y ? 2500 : 1000;
  return ms;
}
function normalizeGoal(goal) {
  if (!goal || !['air','position'].includes(goal.type)) throw violation('underwater_pathfinding','goal needs type air or position');
  if (goal.type==='air') return {type:'air'};
  const p = goal.position;
  if (![p?.x,p?.y,p?.z].every(Number.isFinite)) throw violation('underwater_pathfinding','position goal needs finite x, y and z');
  return {type:'position',position:new Vec3(Math.floor(p.x),Math.floor(p.y),Math.floor(p.z))};
}
function goalKey(goal) { return goal.type==='air' ? 'air' : keyOf(goal.position); }
function heuristic(p,goal) {
  if (goal.type==='air') return 0;
  const q=goal.position;
  return (Math.abs(q.x-p.x)+Math.abs(q.z-p.z))*1000 + Math.max(0,q.y-p.y)*1000 + Math.max(0,p.y-q.y)*2500;
}

// A clock or memory limit is an incomplete search, never proof that a route does not exist.
// The async pacer lets survival and protocol packets run while the frontier is being explored.
async function findUnderwaterPath(bot,input,opts={}) {
  const goal = normalizeGoal(input);
  const start = feetCell(bot);
  const started = Date.now(), deadlineMs=opts.deadlineMs ?? 750;
  const maxCostMs=opts.maxCostMs ?? Infinity;
  if (!Number.isFinite(deadlineMs) || deadlineMs<=0 || !(maxCostMs>=0)) throw violation('underwater_pathfinding','search needs a positive deadline and nonnegative cost allowance');
  return memory.withTemporaryMemory(async track => {
    const frontier=new MinHeap(), scores=new Map(), parents=new Map(), cells=new Map(), occupancy=new Map();
    let abandoned=false, unloaded=false, expanded=0;
    const view={blockAt:p=>{const b=bot.blockAt(p);if(!b)unloaded=true;return b;}};
    const changed=()=>occupancy.clear();
    bot.on('blockUpdate',changed); bot.on('chunkColumnLoad',changed);
    track(() => {
      abandoned=true; frontier.data.length=0; scores.clear(); parents.clear(); cells.clear(); occupancy.clear();
      bot.removeListener('blockUpdate',changed); bot.removeListener('chunkColumnLoad',changed);
    });
    const admitted=p=>{
      const key=keyOf(p);
      if (!occupancy.has(key)) occupancy.set(key,canOccupy(view,p));
      return occupancy.get(key);
    };
    const pace=makeExecutionPacer({sliceMs:5});
    const startKey=keyOf(start);
    scores.set(startKey,0); cells.set(startKey,start);
    frontier.push({pos:start,key:startKey,g:0,f:heuristic(start,goal)});
    const finish=(reason,complete,path=[],costMs=null) => ({reason,complete,path,costMs,expanded,
      elapsedMs:Date.now()-started,goal,start,unloaded});
    if (goal.type==='position' && !view.blockAt(goal.position)) return finish('target_unloaded',false);
    if (goal.type==='position' && !admitted(goal.position)) return finish('target_not_swimmable',true);
    let memoryLimit=memory.budget().cacheCells;
    let budgetPruned=false;
    while (frontier.size) {
      if (opts.cancelled?.() || abandoned) return finish('cancelled',false);
      if (Date.now()-started>=deadlineMs) return finish('search_deadline',false);
      if (expanded%64===0) memoryLimit=memory.budget().cacheCells;
      if (scores.size+frontier.size+occupancy.size > memoryLimit) return finish('search_memory_limit',false);
      const n=frontier.pop();
      if (n.g!==scores.get(n.key)) continue;
      expanded++;
      if (admitted(n.pos) && (goal.type==='air' ? medium(view,n.pos.offset(0,1,0))==='air' : n.pos.equals(goal.position))) {
        const path=[];
        for (let k=n.key;k!==undefined;k=parents.get(k)) path.push(cells.get(k));
        path.reverse();
        if (!pathValid(bot,path)) {
          const at=path.find(p=>!canOccupy(bot,p));
          return {...finish('world_changed_during_search',false),obstruction:at ? {
            position:at,feet:bot.blockAt(at)?.name,head:bot.blockAt(at.offset(0,1,0))?.name,below:bot.blockAt(at.offset(0,-1,0))?.name} : null};
        }
        return finish('route_found',true,path,n.g+1000);
      }
      for (const [dx,dy,dz,cost] of EDGES) {
        const p=n.pos.offset(dx,dy,dz), key=keyOf(p);
        if (!view.blockAt(p)) continue;
        if (!admitted(p)) continue;
        const g=n.g+cost+(opts.penalties?.get(`${n.key}>${key}`) || 0)+(running(view,p) ? FLOW_MS : 0);
        if (g>maxCostMs) { budgetPruned=true; continue; }
        if (g >= (scores.get(key) ?? Infinity)) continue;
        scores.set(key,g); parents.set(key,n.key); cells.set(key,p);
        frontier.push({pos:p,key,g,f:g+heuristic(p,goal)});
      }
      await pace();
    }
    if (abandoned || opts.cancelled?.()) return finish('cancelled',false);
    return finish(budgetPruned ? 'air_budget_exhausted' : unloaded ? 'loaded_frontier_exhausted' : 'no_water_route', !budgetPruned && !unloaded);
  });
}
module.exports = { findUnderwaterPath, normalizeGoal, goalKey, keyOf, center, feetCell, medium, canOccupy, pathValid, pathCost };
