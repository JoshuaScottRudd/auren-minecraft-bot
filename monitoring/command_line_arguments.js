// Auren_Bot/monitoring/command_line_arguments.js
// The one flag reader every monitoring CLI uses (Law 16 — one implementation, one behaviour).
//
// `makeArgs(argv)` takes the argument list instead of reading process.argv at load time, so a bench that
// requires a lens to borrow one function never inherits the lens's own flag vocabulary. Reading argv is
// the caller's act; this file only parses what it is handed.

'use strict';

// argv defaults to the process's own flags for the common case (a CLI's first line); a caller may also
// pass its own array, which makes this safe to require from a test or another tool.
function makeArgs(argv = process.argv.slice(2)) {
  const args = argv.slice();

  // slice(1).join('=') keeps a value that itself contains '=' (a --grep regex, an ISO stamp) intact.
  const opt = (name, dflt) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : dflt;
  };

  const has = name => args.includes(`--${name}`);

  // The first bare (non `--`) token. Every monitoring CLI takes at most one positional — a file path.
  const positional = () => args.find(a => !a.startsWith('--')) || null;

  // Parsed accessors so a caller never re-implements the NaN guard. A malformed number falls back to
  // the stated default (Law 13: a MISSING field is never defaulted; a present, malformed one is).
  const int = (name, dflt) => { const v = parseInt(opt(name, String(dflt)), 10); return Number.isFinite(v) ? v : dflt; };
  const num = (name, dflt) => { const v = parseFloat(opt(name, String(dflt))); return Number.isFinite(v) ? v : dflt; };

  return { args, opt, has, positional, int, num };
}

// `<Nm>`, `<Ns>`, `<NmNs>` → seconds. Returns null on anything else, so the caller decides whether a
// malformed duration is fatal. Shared because three lenses parse the same token shape.
function parseDuration(text) {
  if (!text) return null;
  const t = String(text).match(/^(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!t || (!t[1] && !t[2])) return null;
  return (+(t[1] || 0)) * 60 + (+(t[2] || 0));
}

module.exports = { makeArgs, parseDuration };
