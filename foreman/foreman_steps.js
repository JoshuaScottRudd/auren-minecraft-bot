'use strict';
// foreman_steps.js — the foreman's startup, one proved step at a time.
//
// A startup is a list of steps, and this runner is the only thing that walks one. Each step is:
//
//   name       what is being made true, as a phrase ("the server is running").
//   holds()    SENSE — is it already so? A step that already holds is not acted on: a continued world, a body
//              that is already a spectator, a base already in memory. Optional (absent = never already so).
//   act()      ACT — the one thing that makes it so. It may return { give: reason, lines } when acting has shown
//              it cannot be (Java missing, the port taken) — waiting for proof would only waste the limit.
//              Optional: a step with no act is a precondition that is only sensed.
//   proof()    VERIFY — { ok, why } read from the world, never from act's own return (Law 25). Polled every
//              `every` ms until ok or `within` ms have passed. Only a proved step lets the next one start.
//   tries      how many times act + proof may be attempted (default 1), `retryAfter` ms apart. A step whose
//              failure would say the same thing again gets 1.
//   when       optional predicate — a step that does not apply to this run (a remote world has no server
//              folder) is skipped and said.
//
// The runner publishes where it is (`note({ step, stepState })`, read off the door as `run.step`) and logs one line
// per step: ✓ proved, = already so, - not this run, ✗ with the step's own why. It stops at the first step that
// cannot be proved and returns that step's why, so the caller takes the one shutdown road with a reason a person
// can act on — never a sequence that carries on past a step that did not happen.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── onTimeout — a step that waits but cannot fail ────────────────────────────────────────
// `within` is a deadline. For a step that waits on the fleet's own work, the deadline passing means the
// step failed and the run stops. For a step that waits on a person — the observer camera held while a
// human's Minecraft client boots — a camera nobody opened costs only the wait, since a run nobody is
// watching is still a run.
//
// A step may declare `onTimeout()`, whose verdict replaces the last refusal when the clock runs out. A
// property of the step, since it is what that step waits for (Law 25 — the asker owns the criterion).
async function prove(step, deadline) {
  let last = { ok: false, why: 'not checked yet' };
  for (;;) {
    last = (await step.proof()) || { ok: false, why: 'the check said nothing' };
    if (last.ok) return last;
    if (last.final) return last;
    if (Date.now() >= deadline) return step.onTimeout ? (await step.onTimeout()) : last;
    await sleep(step.every || 1000);
  }
}

// runSteps(steps, { log, note, stopped }) → { ok } | { ok:false, step, why, lines }
//   stopped() — optional; true once the foreman is shutting down, so a startup in progress stops between steps.
async function runSteps(steps, { log, note = () => {}, stopped = () => false }) {
  for (const step of steps) {
    if (stopped()) return { ok: false, step: step.name, why: 'the foreman is shutting down' };
    if (step.when && !step.when()) { log(`  - ${step.name} — not part of this run`); continue; }
    note({ step: step.name, stepState: 'sensing' });
    if (step.holds && await step.holds()) { log(`  = ${step.name} — already so`); continue; }
    const tries = step.tries || 1;
    let result = null;
    for (let t = 1; t <= tries; t++) {
      if (t > 1) {
        log(`    ${step.name}: not yet (${result.why}) — trying again in ${(step.retryAfter || 0) / 1000}s (${t} of ${tries})`);
        await sleep(step.retryAfter || 0);
        if (stopped()) return { ok: false, step: step.name, why: 'the foreman is shutting down' };
      }
      note({ stepState: 'acting' });
      const acted = step.act ? await step.act() : null;
      if (acted && acted.give) { result = { ok: false, why: acted.give, lines: acted.lines, final: true }; break; }
      note({ stepState: 'proving' });
      result = await prove(step, Date.now() + (step.within || 0));
      if (result.ok || result.final) break;
    }
    if (!result.ok) {
      log(`  ✗ ${step.name} — ${result.why}`);
      note({ stepState: 'failed' });
      return { ok: false, step: step.name, why: result.why, lines: result.lines || [] };
    }
    log(`  ✓ ${step.name}${result.why ? ` — ${result.why}` : ''}`);
  }
  note({ stepState: 'done' });
  return { ok: true };
}

module.exports = { runSteps };
