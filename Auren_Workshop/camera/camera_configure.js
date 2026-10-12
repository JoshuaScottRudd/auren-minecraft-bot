// camera_configure — every knob the operator controls on the film director, in one place.
// Pure data, no logic (same contract as Thinking_fragments/architect_config.js); camera_rig.js imports
// this and hardcodes no framing number. Distances are world-axis blocks, angles are degrees.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE MODEL IN ONE PARAGRAPH
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The bots are the subject; scenery is a separate deferred camera. One solver (`solveView`) places every
// shot: fires rays outward from the bot to find open sightlines, scores candidates, screens by an air
// box, confirms the best with a 117-ray cone. Position locks at the cut; aim belongs to the gimbal, a
// headless client the camera /spectate's, which holds still until the bot nears the frame edge.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SEEKER — how one open direction beats another
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// field.* is the sense step: azSteps azimuths × elevs elevations fired outward from the bot's lens
// plane, each reporting clear distance. Candidates sit along those openings. Rank cast rays by reach
// (furthest first), break ties by rung (lowest first), require a 30° bearing change against the last
// shot, then take the first direction whose lens cell passes the air box and the lens box; if none
// does, take the furthest-reaching one — this rig always returns a shot. A single ray at siting time
// records whether the chosen camera can see the bot (Law 25).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  OCCLUSION — the anti-canopy machinery, in four independent layers
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Canopy is the dominant framing problem; four tests cover it, all measured from the LENS, not the feet
// plane the bot's coordinates sit on: the cone (frustum, lens to subject), the air box (ball on the
// lens), the lens box (tube straight ahead), and the mid-hold re-check. Facts and units for each sit
// beside its own key below.
//
// `visualBlockers`: non-solid blocks (`boundingBox: empty` — sugar cane, tall grass, ferns, vines) that a
// raycast passes through but are opaque on screen, checked by name instead, along the centre line and
// inside the air box. Leaves are `boundingBox: block`, so a raycast already stops on them.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE OPERATOR'S EYE, THE HOST SEAT, and THE TWO MODES
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// `architect.*` — a spectator camera a human flies; the rig arms it (spectator, night vision) but never
// commands it, so it never enters the shot list (Law 16, Law 19). Off by default (Law 13); armed only at
// launch (`-Architect` / `--architect`), never by a config edit (Law 26).
// `host.*` — the client a human PLAYS from. Unlike the eye it is a real player, never armed and passed to
// the rig on no list (Law 27), so it can mine, build, die and hire a crew like any other player. Off by
// default, same as the eye.
// `mode.*` — framing (place and cut cameras) and witness (`camera/combat_witness.js`, the server's own
// account of a fight) are independent switches sharing one scout client and one RCON link; either alone,
// both, or neither. Both default off (Law 13); with both off the rig announces which keys to flip and
// exits (Law 8).

'use strict';

// ── THE LENS ITSELF, NAMED ONCE (Law 16) ────────────────────────────────────────────────────────────
// The cone and the site solver both reason in the client's own frustum, so its optics are one pair of
// constants referenced from both. `LENS_FOV_DEG` is VERTICAL field of view (horizontal, ~102° on 16:9,
// is derived).
const LENS_FOV_DEG = 70;
const LENS_ASPECT = 16 / 9;

module.exports = {

  architect: {
    camName: 'Cam_Architect',
    enable:  false,
  },

  host: {
    // Window/instance name (Windows, the titler, a recorder) — not what the server knows this seat as.
    camName:    'Cam_Architect_Control',
    // The name the seat joins under; must be opped (MinecraftServer/ops.json) so the presenter can run a
    // command from inside his own window, and so `foreman get` stamps hires to the name he actually uses.
    playerName: 'KaptainKrispyjr',
    enable:     false,
  },

  mode: {
    framing: false,
    witness: false,
  },

  witness: {
    sampleMs:   100,   // sample rate while a fight is open; an idle fleet writes zero lines regardless
    radius:     24,    // how far around an engaged bot the sample looks, wider than aggro range
    noseRadius: 16,    // RCON wide-area check radius, fires only at a bot the scout cannot see
    nosePollMs: 2000,
    maxRecords: 120000, // runaway guard; hitting it is written into the record
  },

  timing: {
    minHoldMs:   5000,    // hard floor between cuts; a heartbeat re-sending identical coords is not a cut
    maxHoldMs:   15000,   // mandatory reposition even on a well-framed shot; paced with the 30° bearing gate
    snapshotMs:  45000,   // silence this long AND subject out of frame → one static reframe
    droughtMs:   180000,  // silence this long → warn the log parser may have drifted
    logPollMs:   500,     // story drain
    posPollMs:   1000,    // RCON position poll (timing and scout anchoring only, never placement)
  },

  frame: {
    undergroundY: 55,
    absorbRadius: 12,    // a new objective this close to what is already on screen does not cut
    maxShotDist:  7,       // hard ceiling on camera→subject distance, every mode
    camHeight:    1.5,     // THE LENS height above the bot's FEET — exact, not a floor. No elevation.
    // Eye height of the entity the picture renders FROM: the camera client /spectate's the gimbal, so
    // it renders from the gimbal's eye. solveView reasons in LENS coordinates end to end; sendCam
    // subtracts this at the teleport, the only place feet are wanted.
    eyeHeight:    1.62,

    // Non-solid blocks that a raycast passes through but a viewer cannot see past.
    visualBlockers: [
      'sugar_cane', 'tall_grass', 'short_grass', 'fern', 'large_fern', 'vine', 'glow_lichen',
      'cave_vines', 'cave_vines_plant', 'weeping_vines', 'weeping_vines_plant',
      'twisting_vines', 'twisting_vines_plant', 'big_dripleaf', 'small_dripleaf',
      'bamboo', 'sunflower', 'lilac', 'rose_bush', 'peony', 'pitcher_plant',
    ],

    cone: {
      gridH:         13,     // samples ACROSS — more than gridV because the frame is wider than it is tall
      gridV:         9,      // samples DOWN. 13×9 = 117 rays, ~equal world-space spacing on both axes
      fovDeg:        LENS_FOV_DEG,  // must match the client's real vertical FOV
      aspect:        LENS_ASPECT,   // frame width / height — makes the tested region frame-shaped
      frameFraction: 0.7,    // fraction of frame EXTENT that must be canopy-free
      minHalfExtent: 0.9,
      maxHalfExtent: 10,
      // The gate is binary — every ray clear, or rejected. The fraction still returned ranks rejects for
      // the always-return-a-shot fallback and decides nothing else.
    },

    field: {
      azSteps:   32,           // azimuths cast outward per siting
      elevs:     [0, 15, 30],  // rungs above camHeight, ASCENDING (solver ranks by index; rung 0 lowest)
      margin:    2.0,        // stand this far short of what stopped the ray; must exceed `airBox`
      minUsable: 1,          // practical minimum shot distance; a direction offering less is skipped
      airBox:    1,          // radius of the clear ball the lens must centre in: 1 → ~19 cells, 2 → ~81
    },

    // A clear rectangular tube straight out of the lens, `half` blocks to each side, over depths
    // `from`..`to` (clamped short of the subject: backdrop foliage is allowed). Bridges the air box
    // (small, on the camera) and the cone (anchored on the subject). Block lookups only — no rays.
    lensBox: { half: 1, from: 2, to: 5 },

    seek: {
      improve:     0.12,    // beat the current cone score by this to cut mid-hold to a better vantage
      minRoomGain: 4,       // or offer this many more blocks of open room; suppressed during travel shots
    },

    weights: {
      preferredDist:       7,    // target distance the scorer aims for as a bell (too close penalised too)
      minBearingChangeDeg: 30,   // consecutive shots of one subject must differ by at least this in bearing
    },

    objective: {
      idleDroughtMs:      8000,   // silence this long means the bot is idle → the `wide` shot instead
      arrivalRadius:      5,      // travel shot ends once the bot is this close to the destination
      travelDistance:     8,      // clamped to maxShotDist; see wide.distance
      travelCutMinDist:   5,      // leg longer than this frames the destination instead of the walking bot
      travelStageMaxDist: 40,     // beyond this the camera films and follows the bot instead of waiting
      travelMaxHoldMs:    90000,  // stuck-bot safety valve, not a rhythm
    },

    // The see-through (underground) shot: a frozen tripod, no cone, no gimbal — nothing occludes
    // underground and the bot moves slowly enough that swapping cameras on frame-exit is sufficient.
    enclosed: {
      jobPrefixes: ['mine/'],   // job names whose starved above-ground search means ROCK, not thicket
      distance:    7,           // camera→bot
      rise:        3.72,        // LENS height above the bot's FEET — the down-look, not the camera plane
    },

    wide: { distance: 9 },   // idle shot; clamped to maxShotDist like every other mode
    bot:  { aimRise: 0.6, minFramedDist: 2 },   // guaranteed fallback when no candidate can see the subject
  },

  // A camera on a STRUCTURE, not a bot — the swarm is the subject at scale here. Not yet wired into the
  // rig's shot list; `site_framing` reports a shortfall against these criteria (Law 25).
  sites: {
    bearingDeg: 315,   // compass bearing of the camera from the structure; a 45° corner shows three faces
                       //   and reads the same regardless of which way the structure's footprint landed
    fill: 0.80,        // ceiling on how much of the frame the structure's larger apparent axis fills
    elevationDeg: 25,  // how far the lens looks down at the structure's middle
    canopyPad: 3,      // daylight required between the sightline and the highest leaf in the way
    corridorHalfWidth: 8,  // half-width of the swath of columns tested for trees either side of the sightline
    scanTop: 319,      // where the canopy scan starts looking down from (world build ceiling)
  },

  hold: {
    checkHz:           4,
    frameExitDeg:      30,      // frozen-aim fallback only; skipped whenever a gimbal is live
    maxSubjectDist:    40,      // ends a shot when the bot walks off to a speck
    exitGraceMs:       1500,    // frozen-aim fallback only
    heartbeatMs:       1000,    // re-asserts position so a nudge, client drift or respawn snaps back
    occlusionCheckMs:  5000,    // re-test the frame (the 117-ray cone) this often during a hold
    reoccludeScore:    0.35,    // below this (or centre ray blocked) the shot is spoiled → cut
    blockedMinHoldMs:  1200,    // rate limit on the subject-lost cut, so a blocked re-cut cannot machine-gun
    sameShotDist:      1.0,     // a cut landing within this of where the lens already stands is not a cut
    // A sightline blocked within `thrashWindowMs` of the block starting answers first person for
    // `thrashFirstPersonMs` — first person cannot be occluded from its own subject.
    thrashWindowMs:      2000,
    thrashFirstPersonMs: 5000,
  },

  gimbal: {
    enable:            true,
    prefix:            'Gim_',
    deadzoneYawDeg:    22,    // separate from pitch because the frame is far wider than it is tall
    deadzonePitchDeg:  12,
    recenterFrac:      0.35,  // a correction runs until the error is back inside deadzone×this, not
                              //   merely inside the dead zone, so the subject can't sit on the trigger
    easePerTick:       0.12,  // softness of that correction; 1.0 with zero dead zones is a debug setting
    maxRateDegPerTick: 6,     // stops a teleporting bot whipping the camera
    aimRise:           1.2,   // aims at head/upper body
    occlusionMs:       500,   // sightline sample period (camera_gimbal); already the debounce at this rate
    graceChecks:       1,     // consecutive blocked samples before the rig is told
  },

  scout: {
    enable:       true,
    username:     'Scout_Cam',

    // Parks directly above the subject's own column: a loaded chunk is a full vertical column, so only
    // the horizontal coordinate decides chunk loading and entity tracking.
    parkRise:     20,     // blocks above the subject; clears a 70° lens from any shot distance in use
    parkRadius:   48,     // re-park once the subject is this far off the current column
    height:       120,    // fallback altitude for the witness-only centroid park (no framing subject)
    reanchorDist: 32,
    settleMs:     2500,   // upper bound on the wait after a re-park; the rig proceeds once chunks read,
                          //   degrading to a blind shot on timeout, never hanging
    // How long a ray loop may run before ceding a macrotask (execution_yield) — under the 50ms
    // one-tick default so this client's packet handlers keep getting heard during a solve.
    scanSliceMs:  8,
  },
};
