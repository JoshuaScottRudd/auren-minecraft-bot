'use strict';
// camera_spots — the camera angles a person saved, by number, and the words that save them.
//
// A person flies one seat to the shot they want and tells the foreman to save it: the server is read for that
// seat's position and facing (Invariant B), and the shot is kept under a number. Every saved number is one camera
// window `Cam_<number>`, put at its shot when it joins (camera_rig) and left there.
//
// The words arrive by two routes with one implementation (Law 16): the foreman's verbs (`camera-save`,
// `camera-list`, `camera-forget`, from its console or fleet_control) and the flying seat's own chat (`save`,
// `save 4`, `list`, `forget 4`), which the foreman hears off the server's console.
//
// THE FILE LIVES IN camera/clients, gitignored and shared by every copy on the machine by junction. A shot belongs to
// this machine's world, and a tracked file written mid-run would dirty the checkout it ran from.

const fs = require('fs');
const path = require('path');
const { guardExternal, guardExternalSync } = require('./external_library_guard');

const TAG = 'camera_spots';
const FILE = path.join(__dirname, '..', '..', 'Auren_Workshop', 'camera', 'clients', 'camera_spots.json');
const RIG_READY = path.join(__dirname, '..', 'camera_rig_ready.json');

// The shots this machine starts from until its first save. Feet position, then yaw and pitch.
const STARTER = {
  1: { pos: [-34.88116654255924, 88.72645739256133, 61.411492822985444], rotation: [-72.599915, 25.350014] },
  2: { pos: [40.748757245635154, 32.489533977156825, 30.131399416931973], rotation: [91.95084, 48.900032] },
  3: { pos: [30.762377766378066, 65.51713535994239, 69.4721473995003], rotation: [-58.651432, 28.049944] },
};

const VERBS = new Set(['camera-save', 'camera-list', 'camera-forget']);

const seatOf = (number) => `Cam_${number}`;
const numbers = (spots) => Object.keys(spots).map(Number).sort((a, b) => a - b);

function load() {
  if (!fs.existsSync(FILE)) return STARTER;
  const read = guardExternalSync(TAG, `read ${FILE}`, () => JSON.parse(fs.readFileSync(FILE, 'utf8')));
  if (!read.ok) throw new Error(`[camera_spots] CODING VIOLATION (Law 13): ${FILE} does not read: ${read.reason}`);
  return read.value;
}

function write(spots) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(spots, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
}

// camera_configure's two answers: every window, and each window's shot.
const seatNames = () => numbers(load()).map(seatOf);
const bySeat = () => {
  const spots = load();
  return Object.fromEntries(numbers(spots).map(n => [seatOf(n), spots[n]]));
};

// The seats this run's rig armed for a person to fly.
function flownSeats() {
  if (!fs.existsSync(RIG_READY)) return [];
  const read = guardExternalSync(TAG, 'read who the camera rig armed', () => JSON.parse(fs.readFileSync(RIG_READY, 'utf8')));
  return read.ok && Array.isArray(read.value.free) ? read.value.free : [];
}

const describeSpot = (n, s) => `camera ${n} (${seatOf(n)}) at ${s.pos.map(v => v.toFixed(1)).join(', ')} facing ${s.rotation.map(v => v.toFixed(1)).join(' / ')}`;

// The list after the colon of `<who> has the following entity data: [1.5d, 2.0d, -3.25d]`. A seat not in the world
// answers "No entity was found", which holds no list.
function entityList(said) {
  const list = /:\s*\[([^\]]*)\]/.exec(said || '');
  if (!list) return [];
  return list[1].split(',').map(v => parseFloat(v)).filter(Number.isFinite);
}

async function readSeat(who) {
  const read = await guardExternal(TAG, `read where ${who} is`, () =>
    require('./rcon_link').once([`data get entity ${who} Pos`, `data get entity ${who} Rotation`]));
  if (!read.ok) return { ok: false, why: `the server console refused: ${read.reason}` };
  const pos = entityList(read.value[0].body);
  const rotation = entityList(read.value[1].body);
  if (pos.length !== 3 || rotation.length !== 2) {
    return { ok: false, why: `${who} is not in the world (the server says "${(read.value[0].body || '').trim()}")` };
  }
  return { ok: true, spot: { pos, rotation } };
}

const wholeNumber = (v) => (/^[1-9]\d*$/.test(String(v)) ? Number(v) : null);

// run(verb, { number, seat }) → { reason, said } — one answer in words, whichever route asked.
async function run(verb, args = {}) {
  const spots = load();
  if (verb === 'camera-list') {
    return { reason: 'camera_list', said: numbers(spots).map(n => describeSpot(n, spots[n])).join('; ') || 'no cameras saved' };
  }
  const given = args.number != null;
  const number = given ? wholeNumber(args.number) : null;
  if (given && number == null) return { reason: 'camera_refused', said: `'${args.number}' is not a camera number` };

  if (verb === 'camera-forget') {
    if (number == null) return { reason: 'camera_refused', said: 'forget needs the camera number' };
    if (!spots[number]) return { reason: 'camera_refused', said: `there is no camera ${number}` };
    if (numbers(spots).length === 1) return { reason: 'camera_refused', said: `camera ${number} is the last one; save another first or save over it` };
    const { [number]: _gone, ...rest } = spots;
    write(rest);
    return { reason: 'camera_forgotten', said: `camera ${number} forgotten; ${numbers(rest).join(', ')} remain` };
  }

  const flown = flownSeats();
  const who = args.seat || (flown.length === 1 ? flown[0] : null);
  if (!who) {
    return { reason: 'camera_refused', said: flown.length ? `say which seat: ${flown.join(', ')}` : 'no seat to fly is up on this run' };
  }
  const seat = await readSeat(who);
  if (!seat.ok) return { reason: 'camera_refused', said: seat.why };
  const saved = number != null ? number : Math.max(0, ...numbers(spots)) + 1;
  write({ ...spots, [saved]: seat.spot });
  return { reason: 'camera_saved', said: `saved ${who} as ${describeSpot(saved, seat.spot)}${spots[saved] ? ', replacing the old one' : ''}` };
}

const CHAT_RE = /\]: (?:\[Not Secure\] )?<([^>]+)> (.+)$/;

// heard(line, log) — a server console line; a flying seat's `save`, `save 4`, `list` or `forget 4` is run and answered
// in that seat's chat. Anyone else's chat is not a command.
function heard(line, log) {
  const chat = CHAT_RE.exec(line);
  if (!chat) return;
  const words = /^(?:foreman[,:]?\s+)?(save|list|forget)(?:\s+(\S+))?\s*$/i.exec(chat[2].trim());
  if (!words || !flownSeats().includes(chat[1])) return;
  const who = chat[1];
  run(`camera-${words[1].toLowerCase()}`, { seat: who, number: words[2] }).then(async (r) => {
    log(`camera: ${r.said}`);
    const told = await guardExternal(TAG, `answer ${who} in chat`, () =>
      require('./rcon_link').once([`tellraw ${who} ${JSON.stringify({ text: `[foreman] ${r.said}` })}`]));
    if (!told.ok) log(`camera: could not answer ${who} in chat: ${told.reason}`);
  });
}

module.exports = { VERBS, seatNames, bySeat, run, heard };
