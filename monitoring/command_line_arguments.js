// Auren_Bot/monitoring/command_line_arguments.js
// The flag reader every monitoring CLI uses. One implementation, one behaviour.
//
// ── WHY IT EXISTS ─────────────────────────────────────────────────────────────────────────────────
// Every monitoring CLI needs the same flag-parsing behaviour. Duplicating an argument parser across
// tools means each copy can drift independently — a fix or an edge case (like the '=' handling below)
// applied to one copy silently stays unhandled in the others. That is the Law 16 test answered in the
// worst way: deleting one copy would not stop the job being done, only stop it being done CORRECTLY
// everywhere else.
//
// ── WHY A FACTORY AND NOT A MODULE-LEVEL `args` ──────────────────────────────────────────────────
// `makeArgs(argv)` takes the argument list instead of reading process.argv at load time. A module
// that reads argv on require poisons every importer: a bench that requires a lens to borrow one
// function inherits the lens's flag vocabulary, and `--all` typed for the bench silently changes what
// the lens does. Reading argv is the CALLER's act; this file only parses what it is handed.

'use strict';

// argv defaults to the process's own flags for the common case (a CLI's first line), but any caller
// may pass its own array — which is what makes this safe to require from a test or another tool.
function makeArgs(argv = process.argv.slice(2)) {
  const args = argv.slice();

  // slice(1).join('=') so a value that itself contains '=' (a --grep regex, an ISO stamp) survives
  // intact — split('=')[1] truncates at the first '=' and returns a different, well-formed filter.
  const opt = (name, dflt) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : dflt;
  };

  const has = name => args.includes(`--${name}`);

  // The first bare (non `--`) token. Every monitoring CLI takes at most one positional — a file path.
  const positional = () => args.find(a => !a.startsWith('--')) || null;

  // Parsed accessors, so a caller never re-implements the NaN guard. A malformed number falls back to
  // the stated default rather than propagating NaN, which compares false against everything and turns
  // a bad flag into silently-disabled behaviour instead of a visible one (Law 13: never default a
  // MISSING field — but a PRESENT and malformed one is a typo at the pedal, and the default is stated).
  const int = (name, dflt) => { const v = parseInt(opt(name, String(dflt)), 10); return Number.isFinite(v) ? v : dflt; };
  const num = (name, dflt) => { const v = parseFloat(opt(name, String(dflt))); return Number.isFinite(v) ? v : dflt; };

  return { args, opt, has, positional, int, num };
}

// `<Nm>`, `<Ns>`, `<NmNs>` → seconds. Returns null on anything else, so the caller decides whether a
// malformed duration is fatal (a --deadline is a criterion and must fail loudly; a --tail has a
// stated default and may fall back). Shared because three lenses parse the same token shape.
function parseDuration(text) {
  if (!text) return null;
  const t = String(text).match(/^(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!t || (!t[1] && !t[2])) return null;
  return (+(t[1] || 0)) * 60 + (+(t[2] || 0));
}

module.exports = { makeArgs, parseDuration };
