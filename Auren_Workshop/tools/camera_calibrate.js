// camera_calibrate — turn a filmed run into a BLIND judging sheet, so the Architect's eye sets the
// camera thresholds instead of the AI developer's guess.
//
// WHY THIS EXISTS. `cone.minScore` / `cone.frameFraction` are perceptual thresholds: the only correct
// value is the one that matches what the Architect calls a publishable shot. Guessing a number and
// asserting it is the failure Law 25 names (substituting the performer's criterion for the asker's).
// But he cannot judge "0.78" — he can judge a picture. So: the rig logs a cone score for every cut;
// this tool pairs each score with the FRAME that score produced, hides the scores, and hands him a
// numbered contact sheet. His good/bad labels then locate the threshold that separates them. He
// answers in perception, the number is derived. (The video-game gamma-slider pattern, his framing.)
//
// WHY BLIND, AND WHY CHRONOLOGICAL. Frames are stratified across the whole score range so his
// good/bad boundary is pinpointed rather than sampled at one end — but they are DISPLAYED in time
// order, never score order, so position leaks nothing. An anchored judge calibrates the anchor.
//
// WHY IT CANNOT USE THE CONE TO GRADE THE CONE. The score is the thing under test, so the evidence
// must be independent of it: the recorded pixels, judged by the Architect. Scoring the shot with the
// same math that chose the shot is simulation — the deleted guarantee (Law 26).
//
// Usage:  node camera_calibrate.js <video.mp4> [trace.json] [--count=12] [--dur=SEC]
// Writes: footage/calibration/{shot_NN.jpg, contact_sheet.jpg, manifest.json}
//   manifest.json holds the index→score mapping — the ANSWER KEY. Read it only AFTER he has labelled.
'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/camera_calibrate.js');

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = require('../workshop_paths').REPO_ROOT;
const FFMPEG = path.join(ROOT, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
const OUT = path.join(ROOT, 'footage', 'calibration');

const args = process.argv.slice(2);
const flag = (n, d) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=')[1] : d; };
const positional = args.filter(a => !a.startsWith('--'));
const VIDEO = positional[0];
const TRACE = positional[1] || path.join(OUT, 'watcher_camera_rig.jsonl');
const COUNT = parseInt(flag('count', '12'), 10);

if (!VIDEO || !fs.existsSync(VIDEO)) { console.error(`video not found: ${VIDEO}`); process.exit(1); }
if (!fs.existsSync(TRACE)) { console.error(`trace not found: ${TRACE}`); process.exit(1); }
if (!fs.existsSync(FFMPEG)) { console.error(`ffmpeg not found: ${FFMPEG}`); process.exit(1); }

// Recording start from the file's birthtime, compared in EPOCH ms against the trace's ISO stamps —
// so the UTC/local offset never has to be reasoned about (it was a real trap: trace is Z, filename local).
const videoStartMs = fs.statSync(VIDEO).birthtimeMs;
const DUR = parseFloat(flag('dur', '0')) || probeDuration(VIDEO);

function probeDuration(v) {
  const ffprobe = path.join(ROOT, 'tools', 'ffmpeg', 'bin', 'ffprobe.exe');
  const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', v], { encoding: 'utf8' });
  return parseFloat(out.trim());
}

// One cut = one shot the rig committed to, with the cone score that justified it.
const raw = fs.readFileSync(TRACE, 'utf8');
const RE = /\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\][^"]*?CUT #(\d+) (\w+)[^"]*?d([\d.]+) h[\d.]+ \((\d+)% clear(?: ±([\d.]+)b)?/g;
const cuts = [];
let m;
while ((m = RE.exec(raw)) !== null) {
  // +1.5s: far enough past the cut that the teleport has landed and rendered, close enough that the frame
  // still shows what the SCORE described. It was +5s and that was a real methodological bug — on a moving
  // subject with a frozen aim, five seconds was enough for the bot to leave frame, so a 95%-scoring shot was
  // graded against a picture taken long after the moment it described. Score and frame must be the same instant.
  const t = (Date.parse(m[1]) - videoStartMs) / 1000 + 1.5;
  cuts.push({ cut: +m[2], type: m[3], dist: +m[4], score: +m[5] / 100, extent: m[6] ? +m[6] : null, t });
}

const inRange = cuts.filter(c => c.t >= 1 && c.t <= DUR - 2);
console.log(`parsed ${cuts.length} cuts; ${inRange.length} fall inside the ${DUR.toFixed(1)}s recording.`);
if (!inRange.length) { console.error('no cuts inside the video window — check the trace/video pairing.'); process.exit(1); }

// STRATIFY by score so the sample spans the range (a random draw clusters and leaves the boundary
// unresolved), then DISPLAY in time order so nothing about the score is inferable from position.
const byScore = [...inRange].sort((a, b) => a.score - b.score);
const picks = [];
const n = Math.min(COUNT, byScore.length);
for (let i = 0; i < n; i++) picks.push(byScore[Math.round(i * (byScore.length - 1) / (n - 1 || 1))]);
const chosen = [...new Set(picks)].sort((a, b) => a.t - b.t);

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/^shot_\d+\.jpg$|^contact_sheet\.jpg$/.test(f)) fs.unlinkSync(path.join(OUT, f));

const manifest = [];
chosen.forEach((c, i) => {
  const idx = String(i + 1).padStart(2, '0');
  execFileSync(FFMPEG, ['-ss', String(c.t), '-i', VIDEO, '-frames:v', '1',
    '-vf', 'scale=480:-1', '-q:v', '3', path.join(OUT, `shot_${idx}.jpg`), '-y'], { stdio: 'ignore' });
  manifest.push({ index: i + 1, t: +c.t.toFixed(2), cut: c.cut, type: c.type, dist: c.dist, score: c.score, extent: c.extent });
});

const cols = 4, rows = Math.ceil(manifest.length / cols);
const label = "drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='%{eif\\:n+1\\:d}':x=12:y=12:" +
              'fontsize=54:fontcolor=yellow:box=1:boxcolor=black@0.65:boxborderw=10,';
try {
  execFileSync(FFMPEG, ['-framerate', '1', '-i', path.join(OUT, 'shot_%02d.jpg'),
    '-vf', `${label}tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '2',
    path.join(OUT, 'contact_sheet.jpg'), '-y'], { stdio: 'ignore' });
} catch {
  execFileSync(FFMPEG, ['-framerate', '1', '-i', path.join(OUT, 'shot_%02d.jpg'),
    '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '2',
    path.join(OUT, 'contact_sheet.jpg'), '-y'], { stdio: 'ignore' });
  console.log('(labels unavailable — sheet is unlabeled, read left-to-right / top-to-bottom)');
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const s = manifest.map(x => x.score);
console.log(`sheet: ${manifest.length} frames (${cols}x${rows}) → footage/calibration/contact_sheet.jpg`);
console.log(`score span sampled: ${(Math.min(...s) * 100).toFixed(0)}% … ${(Math.max(...s) * 100).toFixed(0)}%  (answer key in manifest.json — do not read it to the Architect before he labels)`);
