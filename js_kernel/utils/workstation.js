'use strict';
// workstation — the ONE answer to "which Java, which Minecraft server folder, and which extra module homes
// does THIS machine have" (Law 16). Every JS caller asks here; the PowerShell side asks here too, through
// the CLI at the bottom (`node workstation.js java|server`), so Java and the server folder each have
// exactly one resolver in the tree.
//
// ── THE RULE, IN HIS WORDS (Architect 2026-09-11) ───────────────────────────────────────────────────────
// *"if run then check stranger way, if fail then architect way. its deterministic code so failure is an
// option. i want my side to be invisible to a stranger and invisible to me."*
//
// So every answer has exactly two legs, always in this order:
//   1. THE STRANGER'S WAY — what anybody who downloaded this bot has: Java on PATH, a server folder named
//      by AUREN_SERVER_DIR, the bot's own node_modules. A stranger's run succeeds or fails here, and the
//      refusal it gets names only these things.
//   2. THE ARCHITECT'S WAY — EXACT paths, read from ONE file one level above the bot:
//      `../Architect_workstation/workstation.json`. It exists on his machines and on nobody else's, so on a
//      stranger's machine this leg is a missing file and nothing more.
//
// ── EXACT PATHS, NEVER A SEARCH ─────────────────────────────────────────────────────────────────────────
// Nothing here globs, walks, or lists a directory above the bot. The folder above a download is somebody
// else's disk — on his machines it sits under a synced personal folder — and a resolver that searched it
// would be reading places it has no business reading. It opens one named file and tests the paths that
// file names, and that is the whole reach.
//
// ── NODE IS THE ONE TOOL THIS FILE NEVER RESOLVES ───────────────────────────────────────────────────────
// Anything running this file is already running on a node that was resolved — by the stranger typing
// `node`, or by `Auren_Workshop/scripts/_node.ps1` on his machines. A child process is started with
// `process.execPath`, the same interpreter, and asking a second time could only produce a second answer.
// The PowerShell resolver reads the `node` list in the same workstation file, which is the one place his
// node paths are written.
//
// ── A CANDIDATE IS RUN, NOT Test-Path'd (Law 25) ────────────────────────────────────────────────────────
// Java is asked for its own home and its own version in one call (`-XshowSettings:properties -version`),
// so the answer is the executable that actually ran and a version it reported about itself — never a file
// that exists and might not start.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BOT_ROOT = path.resolve(__dirname, '..', '..');
const ABOVE_BOT = path.dirname(BOT_ROOT);
const ARCHITECT_FILE = path.join(ABOVE_BOT, 'Architect_workstation', 'workstation.json');

// Minecraft decides this number, not this file: 1.20.5 and every release after it refuse to start under a
// Java older than 21. An older Java on PATH is therefore not "a Java" for this purpose, and it is skipped
// rather than handed to a server that will crash on its first class load.
const JAVA_FLOOR = 21;

// architectPaths(kind) → the exact paths his workstation file lists for `kind`, absolute, in his order.
// An empty list when the file is absent, which is every stranger's machine.
function architectPaths(kind) {
  if (!fs.existsSync(ARCHITECT_FILE)) return [];
  const listed = JSON.parse(fs.readFileSync(ARCHITECT_FILE, 'utf8'))[kind] || [];
  return listed.map(rel => path.join(ABOVE_BOT, rel));
}

// probeJava(cmd) → { exe, major } | { missing: true } | null (present but would not run). `cmd` is
// 'java' (PATH) or an absolute path. "Missing" and "broken" are told apart so a refusal says which.
function probeJava(cmd) {
  const r = spawnSync(cmd, ['-XshowSettings:properties', '-version'], { encoding: 'utf8', windowsHide: true });
  if (r.error && r.error.code === 'ENOENT') return { missing: true };
  if (r.error || r.status !== 0) return null;
  const home = /^\s*java\.home = (.+)$/m.exec(r.stderr);
  const spec = /^\s*java\.specification\.version = (\S+)$/m.exec(r.stderr);
  if (!home || !spec) return null;
  // "1.8" is how Java 8 and older spell their major; 9 onward print it bare.
  const major = parseInt(spec[1].startsWith('1.') ? spec[1].slice(2) : spec[1], 10);
  const exe = path.join(home[1].trim(), 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return { exe, major };
}

// findJava() → { exe: string|null, tried: string[] }.
function findJava() {
  const tried = [];
  const candidates = [['java', 'java on PATH'], ...architectPaths('java').map(p => [p, p])];
  for (const [cmd, label] of candidates) {
    const got = probeJava(cmd);
    if (got && got.exe && got.major >= JAVA_FLOOR) return { exe: got.exe, tried };
    tried.push(!got ? `${label} (did not run)` : got.missing ? `${label} (none)` : `${label} (Java ${got.major}, too old)`);
  }
  return { exe: null, tried };
}

function javaRefusal(tried) {
  return [`No Java ${JAVA_FLOOR} or newer was found. A Minecraft server (1.20.5 and later) will not start under anything older.`,
          `  tried: ${tried.join(', ')}`,
          `  Install a Java ${JAVA_FLOOR}+ runtime (for example Eclipse Temurin), then open a new terminal.`].join('\n');
}

// needJava() → the java executable to launch, or a thrown refusal that names what was tried.
function needJava() {
  const r = findJava();
  if (!r.exe) throw new Error(javaRefusal(r.tried));
  return r.exe;
}

// A server folder is the folder holding server.properties — the same definition world_rollback.ps1 uses
// for its -Root, so the two can never disagree about what counts.
function isServerFolder(dir) { return fs.existsSync(path.join(dir, 'server.properties')); }

// findServerDir() → { dir: string|null, tried: string[] }.
function findServerDir() {
  const tried = [];
  const told = process.env.AUREN_SERVER_DIR;
  if (told && isServerFolder(told)) return { dir: path.resolve(told), tried };
  tried.push(told ? `AUREN_SERVER_DIR=${told} (no server.properties there)` : 'AUREN_SERVER_DIR (not set)');
  for (const dir of architectPaths('server')) {
    if (isServerFolder(dir)) return { dir, tried };
    tried.push(`${dir} (no server.properties there)`);
  }
  return { dir: null, tried };
}

function serverRefusal(tried) {
  return ['No Minecraft server folder was found.',
          `  tried: ${tried.join(', ')}`,
          '  Set AUREN_SERVER_DIR to the folder that holds your server\'s server.properties.'].join('\n');
}

// needServerDir() → the server folder, or a thrown refusal that names what was tried.
function needServerDir() {
  const r = findServerDir();
  if (!r.dir) throw new Error(serverRefusal(r.tried));
  return r.dir;
}

module.exports = {
  findJava, needJava, findServerDir, needServerDir, architectPaths,
  JAVA_FLOOR, ARCHITECT_FILE,
};

// ── CLI — how PowerShell asks the same question without a second resolver ───────────────────────────────
//   node Auren_Bot/js_kernel/utils/workstation.js java     → prints the java executable, or refuses (exit 1)
//   node Auren_Bot/js_kernel/utils/workstation.js server   → prints the server folder, or refuses (exit 1)
// The answer goes to stdout alone so a caller can capture it whole; a refusal goes to stderr.
if (require.main === module) {
  const what = process.argv[2];
  const found = what === 'java' ? findJava() : what === 'server' ? findServerDir() : null;
  if (!found) {
    console.error('usage: node workstation.js java|server');
    process.exit(2);
  }
  const answer = what === 'java' ? found.exe : found.dir;
  if (!answer) {
    console.error(what === 'java' ? javaRefusal(found.tried) : serverRefusal(found.tried));
    process.exit(1);
  }
  console.log(answer);
}
