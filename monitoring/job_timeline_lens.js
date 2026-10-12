// Auren_Bot/monitoring/job_timeline_lens.js
// Reports what the fleet did, in order, and what each job cost: per-job durations, per-bot and
// per-token totals, bot-minute accounting, build supply, return-leg time, and the wood ledger.
//
// Each episode pairs a claim with its close, read off lines the fleet already writes:
//   START   dispatcher      `Claimed [blueprint/build] build/headframe (need: 3) — dispatching to …`
//   END     recursive_judge `… Routing to job_board …`  (seat released)
//   or      building_manager `… COMPLETE …`             (a managed job's own verdict)
//   or      recursive_judge `⏸️ … PLANNER HALTED …`      (killed; nothing replaces it)
// A one-shot job (furnace, dump, torch, canopy, salvage, explore, the two startup locks, wood
// preference) has no manager verdict, so its episode closes on the judge's release. The gap between that
// and the bot's next claim is its own BETWEEN JOBS row.
//
// Passes no verdict on a duration — what counts as long is the asker's number (Law 25), set with
// `--milestones --deadline`.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --jobs [--bot=AurenBot] [--all]

'use strict';

const { relativeTime, percent } = require('./report_formatting');
const { buildEpisodes, jobToken, FOREMAN_UNITS } = require('./trace_read');
// The one writer to stdout; column widths are computed from the data, not authored here.
const out = require('./data_out');

// Rows the by-type table prints before folding the tail into one counted line; --all prints every row.
const TYPE_ROWS = 14;

// ── THE BOT-MINUTE LEDGER ─────────────────────────────────────────────────────
// Accounts for every bot-minute of a body's life, not only the time inside its claimed jobs: startup,
// worked, idle and unaccounted spans, read off `js_kernel/bot_minutes.js`'s own ledger. Claim/release
// gaps cannot see time before the first claim, after the last release, or inside a job claimed and never
// released.
//
// The field set is fixed and flat so nothing here parses prose. `unaccounted` is carried through from
// the body as-is — it is the ledger's own audit of itself.
const BM_SPAN = /\[BOT_MINUTES\][^]*?span=(\w+)(?: job=(\S+))? held=([\d.]+)s \| life=([\d.]+)s startup=([\d.]+)s worked=([\d.]+)s idle=([\d.]+)s unaccounted=(-?[\d.]+)s \| jobs=(\d+)/;
// ── THE PHASE SPLIT ───────────────────────────────────────────────────────────
// Splits idle time at the moment the run's FIRST structure finishes, named `first_structure_built`:
// `STRUCTURE_PRIORITY` only ranks, it does not gate, so a lower-ranked structure can finish first. Keyed
// on job_board's own false→true edge, the same line `build_lenses` splits on (Law 16, one source).
const BM_BUILT = /🏁 STRUCTURE BUILT: '([^']+)'/;
// ── WHAT WAS ON THE BOARD WHILE A BODY STOOD STILL ───────────────────────────
// Joins each idle span to the board as it stood when the span began, so a standing body's idle time can
// be read against what work existed at that moment. A join over lines the fleet already writes; no
// figure here is a new measurement.
const BM_BOARD = /\[JOB_BOARD\]\s*📊\s*(\[[a-z]+\/[a-z]+\].*)$/;
// A posting reads `[band/gate] token {why}` — the token is the identity, the brace is commentary. A
// seat's `{seat 3 of 20 …}` is stripped so seat 3 and seat 4 tally as the same job. Band is kept: the
// same token in `chest` and `blueprint` is two different offers.
const BM_POST = /^\[([a-z]+\/[a-z]+)\]\s*([^|{]+?)(?:\s*\{[^}]*\})?\s*$/;
const BM_FINAL = /\[BOT_MINUTES\][^]*?span=final reason=(.+?) life=([\d.]+)s startup=([\d.]+)s worked=([\d.]+)s idle=([\d.]+)s unaccounted=(-?[\d.]+)s \| jobs=(\d+)/;

// collectBoards(seg) → every board render in the segment, in time order, as `{ atSec, posts }` where
// `posts` maps `band/gate token` → how many seats of it were on that board. One reader of the board
// render for both callers below (Law 16).
//
// A board is one body's own view, not the fleet's: fleet-wide rows (a build's order, a structure's
// execute seat) appear on every body's board, body-local rows (its own toolkit) appear on one. A caller
// folding boards together has to state which way it folds — see `reduceBuildSupply`.
function collectBoards(seg = []) {
  const boards = [];
  for (const l of seg) {
    const bd = BM_BOARD.exec(l.raw);
    if (!bd || l.wallSec == null) continue;
    const posts = new Map();
    for (const chunk of bd[1].split('|')) {
      const p = BM_POST.exec(chunk.trim());
      if (!p) continue;
      const key = `${p[1]} ${p[2].trim()}`;
      posts.set(key, (posts.get(key) || 0) + 1);   // count, so 20 tree seats read as 20 and not as 1
    }
    if (posts.size) boards.push({ atSec: l.wallSec, bot: l.bot || null, posts });
  }
  boards.sort((a, b) => a.atSec - b.atSec);
  return boards;
}

// reduceBotMinutes — one row per body, plus the per-task totals. A body whose ledger never closed has
// its last OPEN span named, on its own row.
function reduceBotMinutes({ seg = [], bot: botFilter = null } = {}) {
  const perBot = new Map();
  const seat = b => {
    if (!perBot.has(b)) {
      perBot.set(b, {
        bot: b, lines: 0, closed: false, reason: null,
        lifeSec: 0, startupSec: 0, workedSec: 0, idleSec: 0, unaccountedSec: 0, jobs: 0,
        lastSpanKind: null, lastSpanLabel: null, lastAtSec: null,
      });
    }
    return perBot.get(b);
  };
  const byToken = new Map();
  // Idle, split two ways: by the dispatcher's own cause, and by whether it fell before or after the
  // run's first structure was finished. Both come off the same span, so the two tables always sum alike.
  const byCause = new Map();
  let firstBuiltSec = null, firstBuiltName = null;
  for (const l of seg) {
    const b = BM_BUILT.exec(l.raw);
    if (b && firstBuiltSec === null && l.wallSec != null) { firstBuiltSec = l.wallSec; firstBuiltName = b[1]; }
  }
  // The board over time, newest-last, so an idle span can be asked what was posted when it began.
  const boards = collectBoards(seg);
  const idleSpans = [];
  // The board as it stood when the span BEGAN, not when it ended — a body decides to idle against the
  // board it could see at that start.
  const boardAt = (sec) => {
    let found = null;
    for (const b of boards) { if (b.atSec <= sec) found = b; else break; }
    return found;
  };

  for (const l of seg) {
    if (!l.bot || FOREMAN_UNITS.has(l.bot)) continue;
    if (botFilter && l.bot !== botFilter) continue;
    let m;
    // Tested first: a final line's shape is a prefix-sibling of the span line, so the span pattern would
    // also match its tail and record the run's closing summary as one more ordinary span.
    if ((m = BM_FINAL.exec(l.raw))) {
      const s = seat(l.bot);
      s.lines++; s.closed = true; s.reason = m[1];
      s.lifeSec = Number(m[2]); s.startupSec = Number(m[3]); s.workedSec = Number(m[4]);
      s.idleSec = Number(m[5]); s.unaccountedSec = Number(m[6]); s.jobs = Number(m[7]);
      s.lastSpanKind = null; s.lastSpanLabel = null;
      continue;
    }
    if ((m = BM_SPAN.exec(l.raw))) {
      const s = seat(l.bot);
      s.lines++;
      // Totals are TAKEN from the newest line, not accumulated: each line already carries the body's
      // running totals to that instant.
      s.lifeSec = Number(m[4]); s.startupSec = Number(m[5]); s.workedSec = Number(m[6]);
      s.idleSec = Number(m[7]); s.unaccountedSec = Number(m[8]); s.jobs = Number(m[9]);
      s.lastSpanKind = m[1]; s.lastSpanLabel = m[2] || null;
      s.lastAtSec = l.wallSec ?? s.lastAtSec;
      const held = Number(m[3]);
      if (m[1] === 'working' && m[2]) {
        const row = byToken.get(m[2]) || { token: m[2], sec: 0, spans: 0, worst: 0, worstBot: null };
        row.sec += held; row.spans++;
        if (held > row.worst) { row.worst = held; row.worstBot = l.bot; }
        byToken.set(m[2], row);
      }
      if (m[1] === 'idle') {
        const why = m[2] || 'unstated';
        const row = byCause.get(why) || { cause: why, sec: 0, spans: 0, beforeSec: 0, afterSec: 0, worst: 0, worstBot: null };
        row.sec += held; row.spans++;
        if (held > row.worst) { row.worst = held; row.worstBot = l.bot; }
        // Attributed by where the span ENDED, the stamp the line carries — a span straddling the
        // boundary is counted whole on the later side (Law 25: the bound is one span, stated not hidden).
        if (firstBuiltSec !== null && l.wallSec != null && l.wallSec <= firstBuiltSec) row.beforeSec += held;
        else row.afterSec += held;
        byCause.set(why, row);
        // The span's START is `relSec - held`, on the FLEET clock (trace_read.stampFleetClock) rather
        // than the body's own, so spans from bodies spawned minutes apart land in the same fleet minute.
        if (l.wallSec != null) {
          const b = boardAt(l.wallSec - held);
          idleSpans.push({ atSec: l.wallSec - held, held, cause: why, bot: l.bot, posts: b ? b.posts : null });
        }
      }
    }
  }

  const rows = [...perBot.values()].sort((a, b) => b.idleSec - a.idleSec);
  const fleet = rows.reduce((t, r) => ({
    life: t.life + r.lifeSec, startup: t.startup + r.startupSec, worked: t.worked + r.workedSec,
    idle: t.idle + r.idleSec, unaccounted: t.unaccounted + r.unaccountedSec, jobs: t.jobs + r.jobs,
  }), { life: 0, startup: 0, worked: 0, idle: 0, unaccounted: 0, jobs: 0 });
  // Bodies whose ledger never closed, and the span each was still inside; named on its own row.
  const openTails = rows.filter(r => !r.closed && r.lines > 0);
  const causes = [...byCause.values()].sort((a, b) => b.sec - a.sec);

  // ── IDLE BY THE MINUTE, so a spike is visible where an average would smooth it out ────────────────
  const perMin = new Map();
  for (const s of idleSpans) {
    const m = Math.floor(s.atSec / 60);
    const row = perMin.get(m) || { min: m, sec: 0, spans: 0, bodies: new Set(), offers: 0, postings: new Map() };
    row.sec += s.held; row.spans++; row.bodies.add(s.bot);
    if (s.posts) {
      // OFFERS is the board's WIDTH — how many claimable postings existed while this body stood still.
      let n = 0;
      for (const [k, c] of s.posts) { n += c; row.postings.set(k, (row.postings.get(k) || 0) + s.held); }
      row.offers = Math.max(row.offers, n);
    }
    perMin.set(m, row);
  }
  const idleByMinute = [...perMin.values()].sort((a, b) => a.min - b.min).map(r => ({
    min: r.min, sec: r.sec, spans: r.spans, bodies: r.bodies.size, widestBoard: r.offers,
    // The three postings on the board longest while somebody stood still — work visible and untaken.
    top: [...r.postings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} (${duration(v)})`),
  }));

  // The same join the other way round: per POSTING, how much idle stood in front of it.
  const byPosting = new Map();
  for (const s of idleSpans) {
    if (!s.posts) continue;
    for (const [k] of s.posts) {
      const row = byPosting.get(k) || { posting: k, sec: 0, spans: 0 };
      row.sec += s.held; row.spans++;
      byPosting.set(k, row);
    }
  }

  return {
    rows, fleet, openTails, firstBuiltSec, firstBuiltName,
    idleByMinute,
    idleBoardUnseen: idleSpans.filter(s => !s.posts).length,
    byPosting: [...byPosting.values()].sort((a, b) => b.sec - a.sec),
    byToken: [...byToken.values()].sort((a, b) => b.sec - a.sec),
    byCause: causes,
    idleBeforeSec: causes.reduce((s, c) => s + c.beforeSec, 0),
    idleAfterSec: causes.reduce((s, c) => s + c.afterSec, 0),
    ledgerSeen: rows.some(r => r.lines > 0),
  };
}

// The idle span between one job's release and the next claim by the SAME bot. Millisecond clock when
// both ends carry one, whole seconds otherwise; null when the two cannot be compared at all, because a
// gap that could not be measured must not be reported as a gap of zero (Law 25).
function gapBefore(prevEnd, job) {
  if (!prevEnd) return null;
  if (prevEnd.ms != null && job.startMs != null) return Math.max(0, (job.startMs - prevEnd.ms) / 1000);
  if (prevEnd.sec != null && job.startSec != null) return Math.max(0, job.startSec - prevEnd.sec);
  return null;
}

// ── HOW MUCH WORK THE BUILD ITSELF OFFERED, MINUTE BY MINUTE ─────────────────
// Reports the build's supply of work every minute, whether anyone was idle or not — a minute where
// nineteen bodies work their own toolkits and the yard offers one seat is a supply problem an
// idle-keyed table cannot see.
//
// What counts as the build's work, read off the board's own text, none inferred:
//   `build/<name>_execute`      the placement seat itself
//   `… →<name> …`               an order whose delivery address is that structure
//   `… ⟨build-order⟩`           a dynamic build order with no address (the bootstrap route), counted in
//                               its own column since it can only be attributed to a structure by
//                               assuming one structure orders at a time (Law 25)
//
// The fold across bodies is MAX: every body renders its own board, and taking the max over a minute asks
// whether a posting existed at all — the right question for a fleet-wide row. A minute with no board
// rendered reports `—`: an unobserved board is not an empty one (Law 13).
const BUILD_ORDER_MARK = '⟨build-order⟩';
const BS_EXECUTE = /\bbuild\/(.+?)_execute\b/;
const BS_DEST = /→\s*([A-Za-z0-9_#]+)/;
// The board's own gate render: `🚧 GATED <gate> (<n>): <why> → <id> [<short>], <id> [<short>], …`
const BS_GATED = /🚧 GATED ([a-z_]+) \((\d+)\): (.+?) → (.+)$/;
// A held id and the shortfall named beside it, matched as a pair since the id list is comma-separated
// and every entry carries its own bracket.
const BS_HELD_ID = /([A-Za-z0-9_#]+)\s*\[([^\]]*)\]/g;
// The assessor mints every build-serving job id under this prefix, so a held row belongs to a build iff
// its id starts here — read off the id, never the prose, which is free to be reworded (Law 10).
const BS_BUILD_ID = /^build_/;

function reduceBuildSupply({ seg = [], jobs = [] } = {}) {
  const boards = collectBoards(seg);
  // Which structure the build work is for, counted off the board: the commonest name among execute seats
  // and addressed orders wins; a tie or empty tally returns null.
  const names = new Map();
  const bump = (n) => { if (n) names.set(n, (names.get(n) || 0) + 1); };
  for (const b of boards) {
    for (const key of b.posts.keys()) {
      const ex = BS_EXECUTE.exec(key);
      if (ex) { bump(ex[1]); continue; }
      if (key.includes(BUILD_ORDER_MARK)) {
        const d = BS_DEST.exec(key);
        if (d) bump(d[1].replace(/#\d+$/, ''));
      }
    }
  }
  const ranked = [...names.entries()].sort((a, b) => b[1] - a[1]);
  const structure = ranked.length ? ranked[0][0] : null;
  const serves = (key) => {
    if (!structure) return false;
    const ex = BS_EXECUTE.exec(key);
    if (ex) return ex[1] === structure;
    const d = BS_DEST.exec(key);
    return !!d && d[1].replace(/#\d+$/, '') === structure;
  };
  const isBootstrap = (key) => key.includes(BUILD_ORDER_MARK) && !BS_DEST.test(key);
  // A job's identity is not its remaining need: the board prints `(need:96)`, `(need:91)`, `(need:78)`
  // as deliveries land on one order, and the need is stripped here so it is not counted as three ids
  // (Law 7). `idle_facing_posting` keeps the need, where the amount of work is the point.
  const idOf = (key) => key.replace(/\s*\(need:\d+\)/, '').replace(/\s*\(seats:(?:\d+|per_body)\)/, '');
  // How many bodies the board said this row could hold, read off job_board's own `(seats:N)`
  // (yield_pledge_calculator.seatsFor), never recomputed here (Law 16, Invariant D). A row with no such
  // token reads `null`, not 1 — a missing measurement is not a measurement of one (Law 13).
  // `seats:per_body` also reads `null`: a per-body row has no share of a total to divide, so it counts
  // toward `job_rows` but not toward a seat sum.
  const seatsOf = (key) => { const m = /\(seats:(\d+)\)/.exec(key); return m ? +m[1] : null; };

  // Per minute: the widest board any body rendered, and the bodies actually holding one of these jobs.
  const perMin = new Map();
  const row = (m) => {
    if (!perMin.has(m)) perMin.set(m, { min: m, seats: null, pledgeSeats: null, ids: new Set(), bootstrap: null, bots: new Set(), peak: 0 });
    return perMin.get(m);
  };
  for (const b of boards) {
    const r = row(Math.floor(b.atSec / 60));
    let seats = 0, boot = 0, pledgeSeats = 0, sawSeatToken = false;
    for (const [key, n] of b.posts) {
      if (serves(key)) {
        seats += n; r.ids.add(idOf(key));
        // Rows, and the bodies those rows can hold, are two different numbers — a job can be one row
        // with many seats.
        const st = seatsOf(key);
        if (st != null) { sawSeatToken = true; pledgeSeats += st * n; }
      } else if (isBootstrap(key)) boot += n;
    }
    r.seats = Math.max(r.seats == null ? 0 : r.seats, seats);
    if (sawSeatToken) r.pledgeSeats = Math.max(r.pledgeSeats == null ? 0 : r.pledgeSeats, pledgeSeats);
    r.bootstrap = Math.max(r.bootstrap == null ? 0 : r.bootstrap, boot);
  }
  // A job's token is the same text the board printed, so one predicate (`serves`) answers both what was
  // offered and what was taken (Law 16). A claim spanning three minutes counts its body in all three.
  const onIt = jobs.filter(j => serves(j.token) && j.startSec != null);
  for (const j of onIt) {
    const end = j.endSec == null ? j.startSec : j.endSec;
    for (let m = Math.floor(j.startSec / 60); m <= Math.floor(end / 60); m++) row(m).bots.add(j.bot);
  }
  for (const [, r] of perMin) {
    const lo = r.min * 60, hi = lo + 60;
    let peak = 0;
    for (let t = lo; t < hi; t++) {
      const n = onIt.filter(j => j.startSec <= t && (j.endSec == null ? j.startSec : j.endSec) > t).length;
      if (n > peak) peak = n;
    }
    r.peak = peak;
  }

  // The other half of the same question: a build job held at a gate is not supply. Folded over the whole
  // run: the useful shape is how long it held and what it was short of.
  const held = new Map();
  for (const l of seg) {
    const g = BS_GATED.exec(l.raw);
    if (!g || l.wallSec == null) continue;
    BS_HELD_ID.lastIndex = 0;
    let h;
    while ((h = BS_HELD_ID.exec(g[4]))) {
      const id = h[1];
      if (!BS_BUILD_ID.test(id)) continue;
      const k = `${id}|${g[1]}`;
      const r = held.get(k) || { id, gate: g[1], why: g[3], shortOf: new Set(), firstSec: l.wallSec, lastSec: l.wallSec, sweeps: 0 };
      // The shortfall is folded to its shape, not kept per sweep: digits become `N` so a live reading
      // like `7/12 blocks in hand` does not grow one set member per distinct count. `sweeps` carries how
      // long it held.
      if (h[2]) r.shortOf.add(h[2].replace(/\d+/g, 'N'));
      r.firstSec = Math.min(r.firstSec, l.wallSec);
      r.lastSec = Math.max(r.lastSec, l.wallSec);
      r.sweeps++;
      held.set(k, r);
    }
  }

  const rows = [...perMin.values()].sort((a, b) => a.min - b.min);
  return {
    structure,
    otherStructuresSeen: ranked.slice(1).map(([n, c]) => `${n} (${c})`),
    boardsSeen: boards.length,
    rows,
    peakSeats: rows.reduce((m, r) => Math.max(m, r.seats == null ? 0 : r.seats), 0),
    peakPledgeSeats: rows.some(r => r.pledgeSeats != null)
      ? rows.reduce((m, r) => Math.max(m, r.pledgeSeats == null ? 0 : r.pledgeSeats), 0) : null,
    peakBodies: rows.reduce((m, r) => Math.max(m, r.peak), 0),
    minutesWithNoSeat: rows.filter(r => r.seats === 0).length,
    firstSeatSec: rows.find(r => r.seats > 0) ? rows.find(r => r.seats > 0).min * 60 : null,
    // Where the table stops, as its own field: the run ending and the fleet going quiet are different
    // facts (Law 25).
    lastBoardSec: boards.length ? boards[boards.length - 1].atSec : null,
    claims: onIt.length,
    heldRows: [...held.values()].sort((a, b) => b.sweeps - a.sweeps),
  };
}

// ── THE ARITHMETIC (machine-facing: returns, prints nothing, exits nothing) ──────────────────────────
function reduceJobTimeline({ seg = [], bot: botFilter = null } = {}) {
  const episodes = buildEpisodes(seg)
    .filter(ep => !botFilter || ep.bot === botFilter)
    .filter(ep => ep.wallSec != null);

  // Prefers the ISO delta over the relative `[Nm Ss]` stamp, which is whole seconds and would misprice
  // sub-second jobs. Falls back to the relative stamps when a line carries no parseable ISO, with the
  // row marked so the fallback is visible (Law 25 — a measurement and an estimate must not print alike).
  const jobs = episodes.map(ep => {
    const startMs = ep.iso ? Date.parse(ep.iso) : NaN;
    const endMs = ep.endIso ? Date.parse(ep.endIso) : NaN;
    const exact = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs;
    const durationSec = exact
      ? (endMs - startMs) / 1000
      : (ep.endRelSec != null && ep.relSec != null ? Math.max(0, ep.endRelSec - ep.relSec) : null);
    const fails = ep.events.filter(e => e.kind === 'fail').length;
    const warns = ep.events.filter(e => e.kind === 'warn').length;
    const errs = ep.events.filter(e => e.kind === 'err').length;
    return {
      bot: ep.bot,
      token: jobToken(ep.claimed),
      claimed: ep.claimed,
      // The rank as the board stated it — `[bot/craft]` today, `P14` in an older run's recorded shape.
      // Both are read so an older run's job does not silently print `?` (Law 25).
      rank: (ep.claimed.match(/^\[([^\]]*)\]/) || [])[1]
         ?? (ep.claimed.match(/^(P\d+)/) || [])[1]
         ?? null,
      manager: ep.manager,
      // `startSec`/`endSec` are the FLEET clock (trace_read.stampFleetClock); readings that compare two
      // bodies (sort order, per-minute tables, concurrency) use these. `botAgeSec`/`endBotAgeSec` are the
      // BODY's own clock — how far into its own life it claimed this — which is what a uniformity
      // question needs, since a body can wake at different points in the run.
      startSec: ep.wallSec,
      endSec: ep.endWallSec,
      botAgeSec: ep.relSec,
      // Duration is measured on one body's own clock: both ends come from the same process, so the
      // relative stamps agree with each other at sub-second precision the fleet stamps round away.
      endBotAgeSec: ep.endRelSec,
      // Carried alongside the relative stamps so the gap between two jobs is measured on the same clock
      // as the jobs themselves; the whole-second fleet stamps round a sub-second gap up.
      startMs: Number.isFinite(startMs) ? startMs : null,
      endMs: Number.isFinite(endMs) ? endMs : null,
      durationSec,
      exact,
      verdict: ep.verdict,
      // The job's own statement of whether it moved anything (an executor's JOB_RESULT line), null when it made none.
      produced: ep.produced ?? null,
      steps: ep.events.filter(e => e.kind === 'ok').length,
      fails, warns, errs,
    };
  }).sort((a, b) => a.startSec - b.startSec || a.bot.localeCompare(b.bot));

  // Per bot: working time and the gaps between its own consecutive jobs — a fleet-wide gap would be
  // meaningless with bots working in parallel.
  const byBot = new Map();
  for (const j of jobs) {
    let b = byBot.get(j.bot);
    if (!b) { b = { bot: j.bot, jobs: 0, workingSec: 0, gapSec: 0, firstSec: j.startSec, lastSec: null, prevEnd: null, longest: null, killed: 0 }; byBot.set(j.bot, b); }
    b.jobs++;
    if (j.durationSec != null) b.workingSec += j.durationSec;
    j.gapBeforeSec = gapBefore(b.prevEnd, j);
    if (j.gapBeforeSec != null) b.gapSec += j.gapBeforeSec;
    if (j.endSec != null) { b.prevEnd = { sec: j.endSec, ms: j.endMs }; b.lastSec = j.endSec; }
    if (j.durationSec != null && (!b.longest || j.durationSec > b.longest.durationSec)) b.longest = j;
    // Reads the verdict's CODE, not its prose sentence, which carries no stability guarantee.
    if (j.verdict && j.verdict.code === 'killed') b.killed++;
  }

  // Per job token: where the run went. Keyed on rank AND token, since `jobToken` strips the rank prefix
  // and `supply/logs` claimed for two different structures must not merge into one row (Law 25). The
  // rank used is the board's coordinates (`bot/craft`), not its per-sweep integer, which is stable
  // across sweeps where the integer is not.
  const byType = new Map();
  for (const j of jobs) {
    const key = `${j.rank ?? '?'} ${j.token}`;
    let t = byType.get(key);
    if (!t) { t = { token: key, claims: 0, totalSec: 0, worst: null, complete: 0, killed: 0, unfinished: 0 }; byType.set(key, t); }
    t.claims++;
    if (j.durationSec != null) t.totalSec += j.durationSec;
    if (j.durationSec != null && (!t.worst || j.durationSec > t.worst.durationSec)) t.worst = j;
    if (j.verdict?.ok === true) t.complete++;
    else if (j.verdict && j.verdict.code === 'killed') t.killed++;
    else if (j.verdict && j.verdict.code === 'open_at_trace_end') t.unfinished++;
  }

  const workedSec = jobs.reduce((s, j) => s + (j.durationSec || 0), 0);
  return {
    jobs,
    byBot: [...byBot.values()],
    byType: [...byType.values()].sort((a, b) => b.totalSec - a.totalSec),
    workedSec,
    spanSec: jobs.length ? Math.max(...jobs.map(j => j.endSec ?? j.startSec)) : 0,
    inexact: jobs.filter(j => !j.exact && j.durationSec != null).length,
  };
}

// Seconds → the trace's own `Nm Ns`, but sub-minute durations keep one decimal so `0m 1s` does not hide
// the difference between a 600ms claim and a 1.4s one.
function duration(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return relativeTime(Math.round(sec));
}

// ── THE WOOD LEDGER ─────────────────────────────────────────────────────────────────────────────────
// Reports wood movement beside job timing, since a job's material cost is part of what it cost.
//
// The trace never states a harvest's YIELD — a claim line is one tree taken, not logs produced — so
// "gathered" is reported only as trees felled and as wood arriving in chests, both directly observed,
// never as trees multiplied by an assumed yield (Law 25). The craft column is labelled "steps posted":
// `→ craft 4x planks` is an announced plan step, re-announced on every replan.
const WOOD_ITEM  = /^(oak_log|logs?|planks?|sticks?)$/;
const TREE_CLAIM = /\[TREE_FELLER\].*Claimed logs at \(-?\d+,-?\d+,-?\d+\) of (\d+)/;
const DEPOSIT    = /deposit (\d+)x (\w+)\s*→/;
const WITHDRAW_B = /withdrew (\d+)x (\w+) from storage/;
const WITHDRAW_S = /Withdrawing (\d+)x (\w+) from staging chest/;
const CRAFT_STEP = /→ craft (\d+)x (\w+)/;
const POCKET     = /planks=(\d+) logs=(\d+)/;

// ── HOW LONG THE WALK BACK COSTS ─────────────────────────────────────────────
// Measures the return leg on its own, separate from a job's whole duration, which otherwise folds the
// walk out, the work, and the walk back into one number.
//
// Pairs two lines `supply_manager` already prints (Law 3, Law 16 — a reading, not a new measurement):
//   "<item> (have N/M) from=… | COMPLETE → deliver to <destination> (<station>)"   ← the load is made up
//   "<item> (M) from=… | deliver complete to <destination> (<station>) | RELEASE"  ← it is in the chest
// The span between them is the walk back plus the chest handling at the far end — nothing here separates
// those, and the destination column is what tells a long walk from a busy barrel.
//
// Paired per bot and per item, oldest open first. A body carries one delivery at a time, so a second
// COMPLETE before the first closes means the first never did — counted as `unclosed`, never matched to
// the wrong end (Law 25: an unmatched leg is not a long leg).
function reduceReturnLegs({ seg = [], bot: botFilter = null } = {}) {
  const OPEN = /\|\s*COMPLETE\s*\S*\s*deliver to ([^(]+)\(([^)]*)\)/;
  const SHUT = /\|\s*deliver complete to ([^(]+)\(([^)]*)\)/;
  // Unanchored, since the line carries the watcher's level glyph and other prefixes. The item is the
  // word before the first bracket ("stone_pickaxe (4) from=…"), stable wherever the sentence starts.
  const ITEM = /([a-z_]{3,})\s*\(/;
  const open = new Map();                       // `${bot}|${item}|${dest}` -> [relSec, …]
  const legs = [];
  let unclosed = 0;
  for (const L of seg) {
    if (!L || typeof L.raw !== 'string' || !Number.isFinite(L.relSec)) continue;
    if (botFilter && L.bot !== botFilter) continue;
    const item = (L.raw.match(ITEM) || [])[1];
    if (!item) continue;
    const shut = L.raw.match(SHUT);
    const start = shut ? null : L.raw.match(OPEN);
    const m = shut || start;
    if (!m) continue;
    const key = `${L.bot}|${item}|${m[1].trim()}`;
    if (!shut) { if (!open.has(key)) open.set(key, []); open.get(key).push(L.relSec); continue; }
    const q = open.get(key);
    if (!q || q.length === 0) { unclosed++; continue; }
    legs.push({ bot: L.bot, item, destination: m[1].trim(), station: m[2], sec: Math.max(0, L.relSec - q.shift()) });
  }
  for (const q of open.values()) unclosed += q.length;

  const byItem = new Map();
  for (const l of legs) {
    const r = byItem.get(l.item) || { item: l.item, sec: 0, legs: 0, worst: 0, worstBot: null };
    r.sec += l.sec; r.legs++;
    if (l.sec > r.worst) { r.worst = l.sec; r.worstBot = l.bot; }
    byItem.set(l.item, r);
  }
  const total = legs.reduce((n, l) => n + l.sec, 0);
  return {
    legs: legs.length,
    unclosed,
    total_sec: total,
    mean_sec: legs.length ? total / legs.length : 0,
    worst: legs.reduce((w, l) => (l.sec > (w ? w.sec : -1) ? l : w), null),
    byItem: [...byItem.values()].sort((a, b) => b.sec - a.sec),
  };
}

function reduceWoodLedger({ seg = [], bot: botFilter = null } = {}) {
  const perBot = new Map();
  const seat = b => {
    if (!perBot.has(b)) perBot.set(b, { bot: b, trees: 0, into: {}, outOfStorage: {}, outOfStaging: {}, craftSteps: {}, peakLogs: 0 });
    return perBot.get(b);
  };
  // The fleet writes one material under two names — `oak_log` (the block id) and `logs` (the recipe
  // root) — merged here so the ledger reports one total, with no addition left to the reader.
  const canon = item => (/^(oak_log|logs?)$/.test(item) ? 'logs' : /^planks?$/.test(item) ? 'planks' : /^sticks?$/.test(item) ? 'stick' : item);
  const add = (o, k, n) => { const c = canon(k); o[c] = (o[c] || 0) + n; };
  let censusFirst = null, censusLast = null;

  for (const l of seg) {
    if (!l.bot || FOREMAN_UNITS.has(l.bot)) continue;
    if (botFilter && l.bot !== botFilter) continue;
    const s = seat(l.bot);
    let m;
    // Read before the match chain, not inside it: `planks=0 logs=3` can share a line with a craft-step
    // match, and continuing past it would skip the pocket reading on that line.
    if ((m = POCKET.exec(l.raw))) s.peakLogs = Math.max(s.peakLogs, Number(m[2]));
    if ((m = TREE_CLAIM.exec(l.raw))) {
      s.trees++;
      if (censusFirst == null) censusFirst = Number(m[1]);
      censusLast = Number(m[1]);
      continue;
    }
    if ((m = DEPOSIT.exec(l.raw)))    { if (WOOD_ITEM.test(m[2])) add(s.into, m[2], Number(m[1])); continue; }
    if ((m = WITHDRAW_B.exec(l.raw))) { if (WOOD_ITEM.test(m[2])) add(s.outOfStorage, m[2], Number(m[1])); continue; }
    if ((m = WITHDRAW_S.exec(l.raw))) { if (WOOD_ITEM.test(m[2])) add(s.outOfStaging, m[2], Number(m[1])); continue; }
    if ((m = CRAFT_STEP.exec(l.raw))) { if (WOOD_ITEM.test(m[2])) add(s.craftSteps, m[2], Number(m[1])); continue; }
  }

  const bots = [...perBot.values()].sort((a, b) => a.bot.localeCompare(b.bot));
  const sum = pick => bots.reduce((acc, s) => {
    for (const [k, v] of Object.entries(pick(s))) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {});
  return {
    bots,
    trees: bots.reduce((n, s) => n + s.trees, 0),
    censusFirst, censusLast,
    into: sum(s => s.into),
    outOfStorage: sum(s => s.outOfStorage),
    outOfStaging: sum(s => s.outOfStaging),
    craftSteps: sum(s => s.craftSteps),
  };
}

// One movement of one item, as table rows — a bucket is a set of measurements, not a phrase for the
// reader to parse. An empty bucket emits a single row with count 0, so an absence is still a measurement.
function movementRows(movement, bucket, prefix = []) {
  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return [[...prefix, movement, null, 0]];
  return entries.map(([item, n]) => [...prefix, movement, item, n]);
}

// ── OUTPUT IS DATA, NOT PROSE ────────────────────────────────────────────────
// Field names and values only; every string in a value cell is copied out of the record (a bot name, a
// job key the board composed, a verdict the judge wrote). This lens authors no sentence about a run.
function runJobTimeline({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const r = reduceJobTimeline({ seg, bot: botFilter });

  out.kv('lens', 'jobs');
  out.kv('record', traceName);
  out.kv('span', relativeTime(r.spanSec));
  if (botFilter) out.kv('bot_filter', botFilter);
  out.kv('jobs', r.jobs.length);

  if (!r.jobs.length) return r;

  out.kv('worked', duration(r.workedSec));
  // A duration timed from the whole-second relative stamp, not the millisecond ISO; also carried as the
  // `exact` column on every row below (Law 25). Field name kept under data_out's column width.
  out.kv('whole_second_timed_rows', r.inexact);

  // ── The story, in order ──
  // The gap BEFORE each job is its own column, not an interleaved row, so it is never mistaken for work
  // — the planning cycle between two claims, computed in the reducer so this cell and the per-bot total
  // agree (Law 16). `claimed_at`/`released_at` are fleet time, `bot_age` is the body's own clock; both
  // are printed since the table is read both down a column and along one bot's rows.
  out.section('job_timeline');
  out.table(
    ['claimed_at', 'released_at', 'bot_age', 'duration', 'gap_before', 'exact', 'bot', 'rank', 'job_key',
      'verdict_ok', 'verdict', 'steps', 'failed_steps', 'warns', 'errors'],
    r.jobs.map(j => [
      relativeTime(j.startSec), j.endSec == null ? null : relativeTime(j.endSec),
      j.botAgeSec == null ? null : relativeTime(j.botAgeSec),
      duration(j.durationSec), duration(j.gapBeforeSec), j.exact,
      j.bot, j.rank, j.token,
      j.verdict ? j.verdict.ok : null, j.verdict ? j.verdict.code : null,
      j.steps, j.fails, j.warns, j.errs,
    ]),
  );

  // ── Where the time went ──
  out.section('by_job');
  const rows = verbose ? r.byType : r.byType.slice(0, TYPE_ROWS);
  out.table(
    ['job_key', 'claims', 'total', 'mean', 'worst', 'share_of_worked', 'complete', 'killed',
      'unfinished_at_trace_end', 'worst_at', 'worst_bot', 'worst_verdict'],
    rows.map(t => [
      t.token, t.claims, duration(t.totalSec), duration(t.totalSec / t.claims),
      duration(t.worst?.durationSec), percent(t.totalSec, r.workedSec),
      t.complete, t.killed, t.unfinished,
      t.worst ? relativeTime(t.worst.startSec) : null,
      t.worst ? t.worst.bot : null,
      t.worst?.verdict ? t.worst.verdict.code : null,
    ]),
  );
  const rest = r.byType.slice(rows.length);
  out.kv('job_types_not_listed', rest.length);
  out.kv('job_types_not_listed_total', duration(rest.reduce((s, t) => s + t.totalSec, 0)));

  // ── Per bot ──
  out.section('by_bot');
  out.table(
    ['bot', 'jobs', 'working', 'working_share', 'between_jobs', 'between_jobs_share', 'first_claim',
      'killed', 'longest_job', 'longest_duration', 'longest_at', 'longest_verdict'],
    r.byBot.map(b => {
      const covered = b.workingSec + b.gapSec;
      return [
        b.bot, b.jobs, duration(b.workingSec), percent(b.workingSec, covered),
        duration(b.gapSec), percent(b.gapSec, covered), relativeTime(b.firstSec), b.killed,
        b.longest ? b.longest.token : null,
        b.longest ? duration(b.longest.durationSec) : null,
        b.longest ? relativeTime(b.longest.startSec) : null,
        b.longest?.verdict ? b.longest.verdict.code : null,
      ];
    }),
  );

  // ── THE BOT-MINUTE LEDGER ───────────────────────────────────────────────────────────────────────
  // `by_bot` above measures shares of COVERED time (working + gaps between jobs); this measures shares
  // of LIFE, so the difference between the two is the time the job sequence never touched.
  const bm = reduceBotMinutes({ seg, bot: botFilter });
  out.section('bot_minutes');
  if (!bm.ledgerSeen) {
    // Stated as absence, not a table of zeroes: a run recorded before the ledger existed has no
    // accounting at all, and a table of zeroes would read as a fleet that did nothing.
    out.kv('ledger', 'absent');
  } else {
    out.kv('bodies', bm.rows.length);
    out.kv('fleet_life', duration(bm.fleet.life));
    out.kv('fleet_startup', duration(bm.fleet.startup));
    out.kv('fleet_worked', duration(bm.fleet.worked));
    out.kv('fleet_idle', duration(bm.fleet.idle));
    // The bodies' own residual summed, not derived here; zero by construction in `bot_minutes.js`.
    out.kv('fleet_unaccounted', duration(bm.fleet.unaccounted));
    out.kv('fleet_jobs', bm.fleet.jobs);
    out.kv('ledgers_never_closed', bm.openTails.length);
    out.table(
      ['bot', 'life', 'startup', 'worked', 'worked_share', 'idle', 'idle_share', 'unaccounted',
        'jobs', 'closed', 'last_span'],
      bm.rows.map(b => [
        b.bot, duration(b.lifeSec), duration(b.startupSec),
        duration(b.workedSec), percent(b.workedSec, b.lifeSec),
        duration(b.idleSec), percent(b.idleSec, b.lifeSec),
        duration(b.unaccountedSec), b.jobs, b.closed,
        // `closed` beside this column already says whether the span ended, so the kind prints bare.
        b.closed ? b.reason : (b.lastSpanKind ? `${b.lastSpanKind}${b.lastSpanLabel ? `:${b.lastSpanLabel}` : ''}` : null),
      ]),
    );
    // ── WHEN AND WHY THE FLEET IDLES ──
    // Two halves: WHEN (before or after the run's first structure stands) and WHY (the dispatcher's own
    // cause), both read off the same idle spans so the two tables sum alike.
    out.section('idle_phase');
    out.kv('first_structure_built', bm.firstBuiltName);
    out.kv('first_structure_built_at', bm.firstBuiltSec == null ? null : relativeTime(bm.firstBuiltSec));
    out.kv('idle_before_first_built', duration(bm.idleBeforeSec));
    out.kv('idle_after_first_built', duration(bm.idleAfterSec));
    out.kv('idle_before_share', percent(bm.idleBeforeSec, bm.idleBeforeSec + bm.idleAfterSec));
    out.section('idle_by_cause');
    out.table(
      ['cause', 'bot_minutes', 'spans', 'mean', 'worst', 'worst_bot', 'before_first_built', 'after_first_built'],
      bm.byCause.map(c => [
        c.cause, duration(c.sec), c.spans, duration(c.sec / c.spans), duration(c.worst), c.worstBot,
        duration(c.beforeSec), duration(c.afterSec),
      ]),
    );

    // ── WHAT WAS ON THE BOARD WHILE BODIES STOOD STILL ──
    // `board_offers` is the width of the board at that minute — claimable postings a standing body could
    // see, which the bot-minute column alone cannot distinguish.
    if (bm.idleByMinute.length) {
      out.section('idle_by_minute');
      out.table(
        ['minute', 'idle', 'spans', 'bodies', 'board_offers', 'posted_and_untaken'],
        bm.idleByMinute.map(r => [
          r.min, duration(r.sec), r.spans, r.bodies, r.widestBoard, r.top.join(' · ') || '—',
        ]),
      );
      if (bm.idleBoardUnseen) {
        out.kv('idle_spans_with_no_board', bm.idleBoardUnseen);
      }

      // The same join the other way: how much standing-still time stood in front of each posting. A
      // posting high here was visible and untaken — the shortage was more ids, not more bodies.
      out.section('idle_facing_posting');
      out.table(
        ['posting', 'idle_in_front_of_it', 'spans'],
        bm.byPosting.slice(0, 20).map(p => [p.posting, duration(p.sec), p.spans]),
      );
    }

    // ── What each task costs, fleet-wide ──
    // A sum over the ledger's own `working` spans, not the job table, so a job claimed and never released
    // still contributes the time it actually held.
    out.section('bot_minutes_by_task');
    out.table(
      ['task', 'bot_minutes', 'spans', 'mean', 'worst', 'worst_bot'],
      bm.byToken.map(t => [
        t.token, duration(t.sec), t.spans, duration(t.sec / t.spans), duration(t.worst), t.worstBot,
      ]),
    );
  }

  // ── How much work the BUILD offered, every minute, idle or not ──
  const bs = reduceBuildSupply({ seg, jobs: r.jobs });
  out.section('build_supply');
  out.kv('structure', bs.structure);
  out.kv('other_structures_on_the_board', bs.otherStructuresSeen.join(', ') || '—');
  out.kv('board_renders_read', bs.boardsSeen);
  if (bs.structure) {
    out.kv('first_minute_with_a_seat', bs.firstSeatSec == null ? null : relativeTime(bs.firstSeatSec));
    out.kv('peak_job_rows_offered', bs.peakSeats);
    // Absent on a run recorded before the board began printing seats — see `seatsOf`.
    out.kv('peak_pledge_seats_offered', bs.peakPledgeSeats);
    out.kv('peak_bodies_on_it', bs.peakBodies);
    out.kv('minutes_offering_no_job', bs.minutesWithNoSeat);
    out.kv('claims_against_it', bs.claims);
    out.kv('last_board_render_at', bs.lastBoardSec == null ? null : relativeTime(bs.lastBoardSec));
    out.table(
      ['minute', 'job_rows', 'pledge_seats', 'distinct_ids', 'bootstrap_orders', 'bodies_on_it', 'peak_at_once', 'postings'],
      bs.rows.map(x => [
        x.min, x.seats, x.pledgeSeats, x.ids.size, x.bootstrap, x.bots.size, x.peak,
        [...x.ids].join(' · ') || '—',
      ]),
    );
    // A build job that was POSTED and HELD is not supply. Printed beside the table so a wide-looking
    // minute and the gate that emptied it are read together, on the same screen.
    out.section('build_supply_held');
    out.table(
      ['job_id', 'gate', 'short_of', 'first_at', 'last_at', 'sweeps_held'],
      bs.heldRows.map(h => [
        h.id, h.gate, [...h.shortOf].join(', ') || '—',
        relativeTime(h.firstSec), relativeTime(h.lastSec), h.sweeps,
      ]),
    );
  }

  // ── The walk back ──
  const rl = reduceReturnLegs({ seg, bot: botFilter });
  out.section('return_legs');
  out.kv('legs_measured', rl.legs);
  out.kv('legs_never_closed', rl.unclosed);
  out.kv('total', duration(rl.total_sec));
  out.kv('mean', duration(rl.mean_sec));
  out.kv('worst', rl.worst ? duration(rl.worst.sec) : null);
  out.kv('worst_bot', rl.worst ? rl.worst.bot : null);
  out.kv('worst_item', rl.worst ? rl.worst.item : null);
  // What the span covers is said in the field names alone: `measured_from`/`measured_to` name the two
  // events themselves (a lens reports fields, not prose).
  out.kv('measured_from', 'supply_manager:COMPLETE_deliver');
  out.kv('measured_to', 'supply_manager:deliver_complete');
  out.table(
    ['item', 'return_time', 'legs', 'mean', 'worst', 'worst_bot'],
    rl.byItem.map(r => [r.item, duration(r.sec), r.legs, duration(r.sec / r.legs), duration(r.worst), r.worstBot]),
  );

  // ── The wood ledger ──
  const w = reduceWoodLedger({ seg, bot: botFilter });
  out.section('wood_ledger');
  out.kv('trees_felled', w.trees);
  out.kv('standing_census_first', w.censusFirst);
  out.kv('standing_census_last', w.censusLast);
  out.table(['movement', 'item', 'count'], [
    ...movementRows('into_chests', w.into),
    ...movementRows('out_of_storage', w.outOfStorage),
    ...movementRows('out_of_staging', w.outOfStaging),
    ...movementRows('craft_steps_posted', w.craftSteps),
  ]);

  out.section('wood_by_bot');
  out.table(['bot', 'trees', 'peak_logs_in_pocket'], w.bots.map(s => [s.bot, s.trees, s.peakLogs]));

  out.section('wood_movements_by_bot');
  out.table(['bot', 'movement', 'item', 'count'], w.bots.flatMap(s => [
    ...movementRows('into_chests', s.into, [s.bot]),
    ...movementRows('out_of_storage', s.outOfStorage, [s.bot]),
    ...movementRows('out_of_staging', s.outOfStaging, [s.bot]),
    ...movementRows('craft_steps_posted', s.craftSteps, [s.bot]),
  ]));

  out.blank();
  return { ...r, wood: w };
}

// ── HAS THE CREW RUN OUT OF WORK? (machine-facing: returns, prints nothing, exits nothing) ──────────
// The one fact a run supervisor needs to know when a standard-procedure run is over: an EVENT (the crew
// took its work and reports nothing outstanding), not a fixed window.
//
// A bot counts as finished only if it CLAIMED at least one job AND its last dispatcher decision was an
// empty-board verdict — idleness alone would count a bot that never woke up as finished (Law 25). Reads
// the dispatcher's own claim and idle-verdict lines and adds no new emit (Law 16).
//
// The dispatcher has four idle verdicts and only two mean finished:
//   nothing_outstanding  the board is empty                                      → FINISHED
//   none_for_species     the board's remainder is outside this species' magnet   → FINISHED for this bot
//   all_gated            work EXISTS and a gate holds it (night, a missing item) → NOT finished
//   claimed_by_peers     a partner holds everything this magnet attracts         → NOT finished
const CLAIM_RE = /\[DISPATCHER\][^]*Claimed \[/i;

// A halted planner is the other way a run is over, and it is not a kind of idle: when the judge kills a
// fragment, the body holds a sentry watch and nothing re-plans it until an operator re-tasks it. Reported
// as TERMINAL, never as finished: the crew running out of work and a mind needing to look are different
// facts, and collapsing the two would be the false success flag Law 25 exists to name.
const HALT_RE = /\[RECURSIVE_JUDGE\][^]*PLANNER HALTED/i;

function reduceCrewStanding({ seg = [], bots = [] } = {}) {
  const perBot = {};
  for (const id of bots) perBot[id] = { bot: id, claims: 0, lastDecision: null, lastRelSec: null, halted: false, haltedAtRelSec: null };

  for (const line of seg) {
    const state = perBot[line.bot];
    if (!state) continue;                       // a bot this run did not fetch is not this run's business
    const text = line.raw || '';
    let decision = null;
    // The cause is kept, not collapsed onto "finished" — an empty board and a board of unclaimable work
    // are different facts (Law 25). A halt is LATCHED, not replaced by a later decision: the body keeps
    // writing quiet-watch lines after one, which must not erase the fact that ends the run.
    if (HALT_RE.test(text)) {
      state.halted = true;
      state.haltedAtRelSec = line.relSec ?? state.haltedAtRelSec;
      continue;
    }
    if (CLAIM_RE.test(text)) { state.claims++; decision = 'working'; }
    else if (/No jobs outstanding/i.test(text)) decision = 'nothing_outstanding';
    else if (/Nothing on the board this species may claim/i.test(text)) decision = 'none_for_species';
    else if (/No jobs CLAIMABLE/i.test(text)) decision = 'all_gated';
    else if (/All jobs this magnet attracts are claimed/i.test(text)) decision = 'claimed_by_peers';
    if (decision) { state.lastDecision = decision; state.lastRelSec = line.relSec ?? state.lastRelSec; }
  }

  const DONE = new Set(['nothing_outstanding', 'none_for_species']);
  const rows = bots.map(id => perBot[id]);
  const finished = rows.filter(r => r.claims > 0 && DONE.has(r.lastDecision));
  const halted = rows.filter(r => r.halted);
  return {
    bots: rows,
    // ANY halted stops the crew — one bot with its planner dropped can never finish its share, since
    // nothing will re-task it. ALL finished is required to call the crew finished, since a crew shares
    // one board and one bot standing while its partner still works is a crew mid-job.
    anyHalted: halted.length > 0,
    halted: halted.map(r => r.bot),
    allFinished: rows.length > 0 && finished.length === rows.length,
    finished: finished.map(r => r.bot),
    working:  rows.filter(r => !(r.claims > 0 && DONE.has(r.lastDecision))).map(r => r.bot),
  };
}

// ── THE TOOLKIT CLOCK, PRICED IN BOT-MINUTES ────────────────────────────────────────────────────────
// Prices toolkit time in bot-minutes (labour), not wall-clock seconds: twenty bodies make the two differ
// by twenty times — a nine-minute stretch where every body equips itself is three bot-hours.
//
// "Full" is defined as leaving the bot band: the board picks the first non-empty band in authored order
// (architect_config's JOB_TYPES), so the instant a body claims a job outside `preconditions`/`bot` its
// own band held nothing. Read off the claim sequence, never an inventory snapshot or a restated kit list
// (Law 16 — architect_config's STOCK_THRESHOLDS owns that list).
//
// A gated bot-band job also leaves the band reading empty, so a body still short of a tool can count as
// filled — an under-estimate never an over-estimate, reported as a floor (Law 25).
//
// Two figures for two questions (Law 29): FILL is one-time, how long before the fleet was ready to
// build. RECURRING is the whole run's bot-band labour, paid again as tools wear out and planks are spent.
const KIT_BANDS = new Set(['bot']);
const PRE_BANDS = new Set(['preconditions']);

function reduceToolkit({ seg = [], bot: botFilter = null } = {}) {
  const r = reduceJobTimeline({ seg, bot: botFilter });
  const bandOf = j => (j.rank || '').split('/')[0] || null;

  const perBot = new Map();
  const bot = (name) => {
    let b = perBot.get(name);
    if (!b) {
      b = { bot: name, firstSec: null, firstAgeSec: null, filledSec: null, filledAgeSec: null, filledBy: null,
            kitJobs: 0, kitSec: 0, kitJobsAfterFill: 0, kitSecAfterFill: 0 };
      perBot.set(name, b);
    }
    return b;
  };

  for (const j of r.jobs) {
    const b = bot(j.bot);
    const band = bandOf(j);
    if (b.firstSec == null) { b.firstSec = j.startSec; b.firstAgeSec = j.botAgeSec; }
    if (KIT_BANDS.has(band)) {
      b.kitJobs++;
      b.kitSec += j.durationSec || 0;
      if (b.filledSec != null) { b.kitJobsAfterFill++; b.kitSecAfterFill += j.durationSec || 0; }
    } else if (band && !PRE_BANDS.has(band) && b.filledSec == null) {
      // The claim's START is the moment the band was found empty.
      b.filledSec = j.startSec;
      // How far into its own life, read off the body's own clock, since bodies spawn one at a time and
      // a run-clock measurement would price the spawn stagger as toolkit time.
      b.filledAgeSec = j.botAgeSec;
      b.filledBy = j.token;
    }
  }

  const rows = [...perBot.values()].sort((a, b) =>
    (a.filledSec ?? Infinity) - (b.filledSec ?? Infinity) || a.bot.localeCompare(b.bot));
  const filled = rows.filter(x => x.filledSec != null);
  // Time to fill is the body's own age when it left the band — the number that answers whether the kit
  // is uniform, unaffected by the spawn queue's own stagger.
  for (const x of rows) x.fillSec = x.filledAgeSec == null ? null : Math.max(0, x.filledAgeSec);
  const fillSecs = filled.map(x => x.fillSec).sort((a, b) => a - b);

  const fleetBotSec = r.spanSec * rows.length;
  return {
    ...r,
    perBot: rows,
    bots: rows.length,
    filledCount: filled.length,
    fillBotSec: fillSecs.reduce((s, v) => s + v, 0),
    fillMedianSec: fillSecs.length ? fillSecs[Math.floor(fillSecs.length / 2)] : null,
    fillWorstSec: fillSecs.length ? fillSecs[fillSecs.length - 1] : null,
    fillBestSec: fillSecs.length ? fillSecs[0] : null,
    kitBotSec: rows.reduce((s, x) => s + x.kitSec, 0),
    kitJobs: rows.reduce((s, x) => s + x.kitJobs, 0),
    kitBotSecAfterFill: rows.reduce((s, x) => s + x.kitSecAfterFill, 0),
    kitJobsAfterFill: rows.reduce((s, x) => s + x.kitJobsAfterFill, 0),
    fleetBotSec,
  };
}

const botMin = (sec) => (sec == null ? null : Number((sec / 60).toFixed(1)));

function runToolkit({ seg = [], traceName = '?', bot: botFilter = null } = {}) {
  const r = reduceToolkit({ seg, bot: botFilter });

  out.kv('lens', 'toolkit');
  out.kv('record', traceName);
  out.kv('span', relativeTime(r.spanSec));
  if (botFilter) out.kv('bot_filter', botFilter);
  out.kv('bots', r.bots);
  out.kv('fleet_bot_min', botMin(r.fleetBotSec));
  if (!r.jobs.length) { out.kv('jobs', 0); return r; }

  // ── ONE-TIME: how long before each body stopped working for itself ──
  // Three columns, three clocks, named so they cannot be summed by mistake: `woke_at_fleet` and
  // `kit_full_at_fleet` are the run's own clock, `kit_took` is the body's elapsed time and the only one
  // that answers "is the kit uniform".
  out.section('toolkit_fill');
  out.table(
    ['bot', 'woke_at_fleet', 'kit_full_at_fleet', 'kit_took', 'bot_min_to_fill', 'kit_jobs_before', 'left_band_for'],
    r.perBot.map(x => [
      x.bot,
      x.firstSec == null ? null : relativeTime(x.firstSec),
      x.filledSec == null ? 'never' : relativeTime(x.filledSec),
      x.fillSec == null ? 'never' : relativeTime(x.fillSec),
      botMin(x.fillSec),
      x.kitJobs - x.kitJobsAfterFill,
      x.filledBy || '—',
    ]),
  );

  out.section('toolkit_fill_totals');
  out.kv('bots_that_filled', r.filledCount);
  out.kv('bots_never_filled', r.bots - r.filledCount);
  out.kv('fill_bot_min_total', botMin(r.fillBotSec));
  out.kv('fill_bot_min_median', botMin(r.fillMedianSec));
  out.kv('fill_bot_min_fastest', botMin(r.fillBestSec));
  out.kv('fill_bot_min_slowest', botMin(r.fillWorstSec));
  out.kv('fill_share_of_fleet', percent(r.fillBotSec, r.fleetBotSec));
  // A floor, never a point estimate — a gated kit job empties the band too, so a body short of a tool it
  // cannot obtain counts as filled.
  out.kv('fill_time_measure', 'floor');

  // ── RECURRING: what the kit cost across the WHOLE run, fill included ──
  out.section('toolkit_recurring');
  out.kv('kit_jobs_total', r.kitJobs);
  out.kv('kit_bot_min_total', botMin(r.kitBotSec));
  out.kv('kit_share_of_fleet', percent(r.kitBotSec, r.fleetBotSec));
  out.kv('kit_jobs_after_fill', r.kitJobsAfterFill);
  out.kv('kit_bot_min_after_fill', botMin(r.kitBotSecAfterFill));
  out.kv('refill_share_of_fleet', percent(r.kitBotSecAfterFill, r.fleetBotSec));

  // ── WHICH PIECE OF THE KIT ATE IT ──
  const byKit = new Map();
  for (const j of r.jobs) {
    if (!KIT_BANDS.has((j.rank || '').split('/')[0])) continue;
    const t = byKit.get(j.token) || { token: j.token, claims: 0, sec: 0 };
    t.claims++; t.sec += j.durationSec || 0;
    byKit.set(j.token, t);
  }
  out.section('toolkit_by_item');
  out.table(
    ['kit_job', 'claims', 'bot_min', 'share_of_kit', 'share_of_fleet'],
    [...byKit.values()].sort((a, b) => b.sec - a.sec).map(t => [
      t.token, t.claims, botMin(t.sec), percent(t.sec, r.kitBotSec), percent(t.sec, r.fleetBotSec),
    ]),
  );
  return r;
}

module.exports = { reduceJobTimeline, reduceWoodLedger, reduceBotMinutes, reduceBuildSupply, runJobTimeline, reduceCrewStanding, reduceToolkit, runToolkit };
