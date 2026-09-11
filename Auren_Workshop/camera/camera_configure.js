// camera_configure — every knob the Architect controls on the film director, in one place.
// Pure data, no logic (same contract as Thinking_fragments/architect_config.js). camera_rig.js imports
// this and hardcodes no framing number. Distances are world-axis blocks, angles are degrees.
//
// LAYOUT: knobs live in one compact block at the bottom; the prose explaining every knob lives above it,
// once. Read the section here, then set the number there. Nothing is explained twice.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE MODEL IN ONE PARAGRAPH
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The bots are the subject; scenery is a separate deferred camera. One solver (`solveView`) places every
// shot: the scout fires rays OUTWARD from the bot to find where the open sightlines actually are, camera
// candidates are placed along those openings, scored, screened by an air-box, and the best few confirmed
// with an 117-ray cone. Position is LOCKED at the cut. AIM IS NOT — it belongs to the gimbal, a headless
// client the camera /spectate's, which holds perfectly still until the bot nears the frame edge.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  TIMING — how often the camera is allowed to move
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// `minHoldMs` is a HARD FLOOR on camera movement — a shot may never be replaced sooner, so the camera
// cannot move more than once per 5s (faster cutting reads as dizzying). The heartbeat re-sending identical
// coords is not a move. Don't go below 5000.
// `maxHoldMs` is the mandatory reposition: even a perfectly framed subject gets a fresh angle eventually.
// The gimbal removed the need to rebuild a shot whenever a frozen aim lost the subject, so this no longer
// needs to run short to compensate — but held too long, even a good shot reads as stale. THIS is the
// pacing dial, and it now works WITH a hard 30° bearing gate — see THE SEEKER.
// `snapshotMs` — silence this long AND subject out of frame → one static reframe. `droughtMs` — silence
// this long → warn that the log parser may have drifted. `logPollMs`/`posPollMs` — story drain and RCON
// position poll (timing and scout anchoring only, never placement).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  DISTANCE — how far the camera stands
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// `preferredDist` is the target the scorer aims for as a BELL (too close is penalised as well as too far),
// `maxShotDist` is the hard ceiling on every mode, and the practical MINIMUM is `field.minUsable` — a
// direction offering less clear room than that is skipped entirely.
// Minimum was briefly tightened to kill a wedged-in-canopy pocket, but clamping the camera to bot level
// changed the calculus: a horizontal-only search cannot escape upward, so a tighter minimum in dense forest
// starves almost every azimuth, and the boxed-in fallback then delivers a pocket shot anyway — worse than
// simply allowing the camera closer. What actually carries the anti-pocket load is the air box and the lens
// box, which the fallback now also respects.
// `wide` is the idle shot — now only slightly wider, at the same height as every other shot. `objective.travelDistance`
// frames the destination shot. `bot.minFramedDist` is how close the guaranteed fallback pulls in when NO
// candidate could see the subject at all.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  ONE SEEKER — the ranked path is deleted; what was the fallback is the seeker
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// There were TWO ways to site a camera: a ranked path that built a candidate per open direction, filtered
// each through the air box and the lens box, then confirmed the survivors with a 117-ray cone gate — and a
// fallback for when that produced nothing, which sorted the raw rays by reach and took the first whose lens
// cell was clear. Two implementations of one capability is a Law 16 violation on its own; what settled it
// is which of them was actually running. Measured over a full filmed run: the ranked path produced ZERO
// candidates on every siting, so the fallback placed every shot in the take — and that footage is good.
//
// The ranked path is therefore deleted rather than repaired. Keeping a route that the terrain this fleet
// works in cannot reach is a pathway the system believes it has, and the belief is the defect: two runs of
// reasoning about "the seeker's preference order" described code that never executed once.
//
// WHAT THE SURVIVING SEEKER IS: rank the cast rays by REACH (furthest first), break ties by rung (lowest
// first), require the 30° bearing change against the last shot, then walk that order and take the first
// direction whose lens cell passes the air box and the lens box. If none does, take the furthest-reaching
// one anyway — this rig must always return a shot.
//
// WHAT WENT WITH IT, and none of it should come back without a filmed run showing the terrain changed:
//   · the per-candidate 117-ray CONE GATE (`clean` / `best_of_bad`). It demanded every ray of a rectangle
//     covering 70% of the frame, which no forest frame ever satisfies — 0.7% of sitings passed it across
//     442 attempts. A gate nothing passes is not a standard, it is a disabled branch.
//   · `topK` / `perRungK`, the cone budget and its per-rung stratification.
//   · the frame-purity SCORE as a siting key. It graded leaves at the frame edges, which is what a forest
//     shot looks like when it is working.
// The cone itself survives in ONE place — the mid-hold `frame_spoiled` re-check — and that is a different
// question: not "which vantage is best" but "has the shot I am already running died". A single ray still
// runs at siting time to record whether the chosen camera can see the bot, because that fact is the one
// the record was missing when the ranked path's numbers were mistaken for shot quality (Law 25).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  HEIGHT — A LADDER, AND WHY THE RULE AGAINST ONE WAS RETIRED RATHER THAN BROKEN
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// `camHeight` is the BOTTOM rung — bot eye level, above the bot's feet — and `field.elevs` are the rungs
// above it. A candidate on rung θ stands at eyePt.y + usable·sin(θ), so the ladder's real height depends on
// how far out the shot lands: at the 7-block ceiling the three rungs are 1.5b / 3.3b / 5.0b above the
// bot's feet, and a 3-block shot puts them at 1.5b / 2.3b / 3.0b.
//
// THE LADDER IS A TIEBREAK NOW, AND NOTHING ELSE. The seeker ranks directions by how far they REACH and
// uses the rung only to separate two that reach equally far — lowest first.
//
// The original rule was ONE PLANE, NO ELEVATION: "at bot level you shoot between TRUNKS; the instant the
// lens rises it looks DOWN, and looking down in a forest means looking through canopy." That was a PROXY —
// it banned height because height USUALLY means canopy. It was retired in favour of measuring each
// candidate against a per-shot cone gate, and that gate is now gone too (see ONE SEEKER below), so what
// remains is the plainer statement the proxy was reaching for: elevation is not free in this terrain.
// Leaves sit above a bot, so every degree of rise adds canopy between lens and subject and forces the lens
// to look down through the layer it just climbed into. Hence lowest-first.
//
// The bottom rung is `camHeight` — level with the bot's own eye, never below it — so "lowest" is a level
// shot rather than a worm's-eye one, and a rung is still REACHED FOR when it out-reaches the others: an
// open rooftop wins on distance, which is the primary key, not on height.
//
// TWO GUARDS WENT EARLIER AND SHOULD STAY GONE:
//   · the off-plane REJECT in solveView, which dropped any candidate not exactly at camHeight. It would
//     now reject every rung but the bottom.
//   · `weights.lowAngle`, the anti-top-down bias, and `highAngle`, the wide shot's inversion of it. A
//     scoring bias is precisely what failed here before — "prefer low" lost to distance and clarity and
//     quietly delivered high shots anyway. The ordering is strict now, so nothing can outvote it, and the
//     low preference lives in that ordering rather than in a weight for exactly this reason.
// WHAT STILL ENCODES THE TASTE is the CEILING: `field.elevs` tops out at 30°, and that list is the only
// thing standing between this and a map-view camera. Raise it deliberately, having looked at footage.
//
// The search is still cast from the plane it shoots from, and that has not changed: measuring clearance at
// one height and placing the lens at another measures one line and uses a different one.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  OCCLUSION — the anti-canopy machinery, in three independent layers
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Canopy is the dominant framing problem, and no single test catches it, so there
// are four, each covering what the others structurally cannot. Three of them are SHAPES around the lens,
// and the point is that they are different shapes: a ball, a tube, and a frustum. Canopy that beats one
// of them is normally sitting in the volume the other two do not occupy.
//
// EVERY ONE OF THEM IS MEASURED FROM THE LENS. That reads as obvious and was not true until the eyeHeight
// note above: the tests ran on the feet plane while the picture came from 1.62 blocks higher, so a shot
// could pass all of them and still open on leaves. Nothing below means anything if that drifts again.
//
// (1) THE CONE (`cone.*`) — a 117-ray frustum from lens to subject, graded. Its cross-section is ANGULAR:
//     it grows linearly with distance exactly as the real frame does, so the dials mean the same thing at
//     4 blocks and at 30. `fovDeg` MUST match the camera client's real VERTICAL FOV or the cone vouches
//     for a frame nobody is rendering, and `aspect` MUST match its shape — a SQUARE cone certified about a
//     quarter of a 16:9 picture and called it "100% clear", which is most of how a fully-canopied frame
//     scored perfectly. `frameFraction` is the cinematographic dial — the fraction of FRAME EXTENT that
//     must be canopy-free (0.7 = subject plus real headroom, leaving the outer border where distant
//     foliage reads as depth). `gridH`/`gridV` are RESOLUTION ONLY and do not change the tested area.
//     THE GATE IS BINARY: every ray clear, or the candidate is rejected (Architect: "blocked means anything
//     that obscured the view, any block that is. good means no blocking"). There is no threshold to tune,
//     which is the resolution of a `minScore` that had been carried as UNCALIBRATED for as long as it
//     existed — good frames and canopy-blocked frames scored in overlapping ranges, and the honest fix
//     turned out to be removing the decision rather than finding the number. The fraction the cone still
//     returns ranks the REJECTS for the always-return-a-shot fallback and decides nothing.
// (2) THE AIR BOX (`field.airBox`) — the lens must sit at the centre of a clear ball of this radius. It
//     catches what the cone cannot see: leaves pressed against the camera from behind or to the side. And
//     it is what a ROTATING gimbal requires — the cone validates ONE bearing, but a panning camera needs
//     clearance in every direction it may turn toward. Block lookups only, so it screens BEFORE the cone.
//     READ IT WITH `field.margin`: the box has to be clear of whatever stopped the outward ray, and the
//     camera is parked `margin` short of exactly that. At margin 1.5 a radius-2 box was testing a wall
//     1.5 blocks behind the lens and rejecting nearly every vantage in forest — which is not the gate
//     working, because the boxed-in fallback then fires and defeats it silently. The two moved together.
// (3) THE LENS BOX (`lensBox`) — a clear tube of fixed width straight ahead, covering the near field the
//     ball is too small for and the frustum is too narrow for. See the block on the setting itself.
// (4) THE RE-CHECK (`hold.occlusionCheckMs`, `hold.reoccludeScore`) — layers 1-3 run at the CUT, and a
//     hold can run long enough that the world moves underneath it. So visibility is re-tested during the
//     hold, and a spoiled shot cuts away. A shot dies if the bot itself is hidden (centre ray blocked) or
//     the frame falls below reoccludeScore. NOTE what this layer still does not do: the gimbal pans
//     continuously and fires no rays at all, so between re-checks the frame can rotate onto foliage that
//     nothing has looked at. The lens box is the standing defence for that, not this.
//
// `visualBlockers` exists because BOUNDING BOXES LIE about what the camera sees. Sugar cane, tall grass,
// ferns and vines are all `boundingBox: empty` with no collision shapes, so a raycast passes straight
// through them — yet they are opaque on screen and a bot standing behind sugar cane is invisible. They
// cannot be caught by a raycast matcher either (the raycast needs shapes to intersect), so they are checked
// by name along the centre line and inside the air box. Leaves are NOT in the list: `boundingBox: block`,
// so raycasts already stop on them.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SEEKER — how one open direction beats another
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// `field.*` is the SENSE step: `azSteps` azimuths × `elevs` elevations fired outward from the bot's LENS
// PLANE, each reporting clear distance (64×1 = 64 rays, a few ms). Candidates are placed along those real
// openings, which is why the seeker never dead-ends on "no clear candidate" — worst case it takes the most
// open direction. `margin` stops the camera short of the wall the ray hit; `topK` is how many survivors get
// the full 117-ray cone confirm.
// `weights.*` rank them: `distFit` (subject size), `lowAngle` (the dominant anti-top-down bias), `approach`
// (sit on the side the bot walks in from), `variety` (satisfy the 30-degree rule), `room` (a mild bonus for
// a breathable vantage). `minBearingChangeDeg` is the 30-DEGREE RULE — consecutive shots of one subject
// must differ by at least this in bearing or the cut reads as a jarring jump. Photography law, not taste.
// `seek.*` governs cutting mid-hold to a materially better vantage: it must beat the current cone score by
// `improve` OR offer `minRoomGain` more blocks of open room. Suppressed during a travel shot.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE DESTINATION SHOT (`objective.*`)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A leg longer than `travelCutMinDist` frames the camera around the DESTINATION rather than the walking
// bot: it waits at the far end and the bot walks INTO the lens, held unbroken until `arrivalRadius` says
// the walk is over — this reads better than cutting mid-travel for only a few seconds of the bot walking.
// Travel opens at >5 and closes at ≤5 — ONE threshold, so it cannot self-cancel (a separate, larger arrival
// radius previously fired on the first tick of every shorter leg).
// `travelMaxHoldMs` is a stuck-bot safety valve, never a rhythm. The shot only became possible with the
// gimbal: a frozen aim pointed at the destination would hold an empty field for the whole walk, so without
// a live gimbal this falls back to framing the bot.
// `idleDroughtMs` — silence this long means the bot is idle, and the idle `wide` shot is taken instead.
// `absorbRadius` — a new objective this close to what is already on screen is ALREADY in frame, so it does
// not cut. That is what collapses the goTo firehose into a filmable cut rate.
// `travelStageMaxDist` is the LEG LENGTH CEILING on staging at the destination, and it exists because the
// destination shot fails silently on a long leg: with no entity to track from far enough away, the gimbal
// holds its last aim (correctly — it must never swing at a subject it cannot see), so the shot becomes a
// motionless picture of empty ground rather than a visible failure. Beyond this radius the camera films the
// BOT and follows it, and the destination shot takes over once the bot is close enough.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SEE-THROUGH SHOT (`enclosed.*`) — the underground camera is a DIFFERENT camera
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Underground uses a different, simpler camera model entirely: no gimbal, no interpolation, because
// there is nothing to block underground and the bot moves slowly enough that swapping cameras when it
// leaves frame is sufficient on its own.
//
// A spectator renders THROUGH rock, so underground every constraint the above-ground rig exists to satisfy
// is void: nothing occludes, so the cone measures nothing; there is no canopy, so the camera plane buys
// nothing; the bot moves slowly in a tunnel, so a frozen aim with a frame-exit cut is sufficient and reads
// cleaner than a tracking head. It is the old pre-seeker tripod, deliberately kept.
//
// WHY THE Y THRESHOLD ALONE WAS WRONG, which is what regressed. `undergroundY` classifies by DEPTH, and a
// shaft collared near the surface is not deep — so shaft shots ran the full above-ground search. That
// search probes horizontally only (the canopy fix), and a shaft offers no horizontal sightline at all: the
// field search starves in every direction, and the boxed-in fallback drops the lens close against the bot
// inside the rock. As the bot dug downward the gimbal then tracked it straight down, angling the shot
// steeply into the ground.
// So enclosure is detected by TWO signals, either sufficient: depth (`undergroundY`), or a job the bot itself
// announced as mining (`jobPrefixes`) WHILE the field search came back starved. The second half of that
// conjunction matters — walking to the mine is a mining job in open forest, and must keep the real seeker.
// A starved field in a forest thicket is NOT this case and still takes the boxed-in fallback.
// `distance`/`rise` restore the framing that worked before the seeker existed (camera `rise` above the bot's
// feet at `distance` blocks, aimed down at it).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE HOLD (`hold.*`)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// `checkHz` is how often the hold is evaluated. `maxSubjectDist` ends a shot when the bot walks off to a
// speck — no aim can rescue that. `frameExitDeg`/`exitGraceMs` are the FROZEN-AIM exit test and are SKIPPED
// whenever a gimbal is live: measuring the bot against the cut-time aim would report "left frame" for a bot
// the gimbal is holding perfectly, and every such report becomes a cut. They survive only for the no-gimbal
// fallback. `heartbeatMs` re-asserts position so a nudge, client drift or respawn snaps back within a second.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE GIMBAL (`gimbal.*`) — continuous aim that still reads as a static shot
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A headless client parked at the camera position, look()ing at the bot; the camera /spectate's it, so its
// head rotation IS the aim and is interpolated to render framerate. This works ONLY because clients
// interpolate the rotation of an ENTITY they watch and never the local player's — verified by measurement,
// not assumed. The rig owns where to stand and when to cut; the gimbal owns only the aim.
// It must read STATIC, not like a constantly-adjusting rookie operator, so: the camera holds perfectly still
// while the bot roams inside `deadzoneYawDeg`/`deadzonePitchDeg` (separate, because the frame is far wider
// than it is tall — one shared dead zone would be wrong on one axis by construction), and a cut SNAPS
// rather than swinging into the new shot.
// `recenterFrac` is the hysteresis that actually kills the twitch: a correction, once started, runs until
// the error is back inside deadzone×this, NOT merely inside the dead zone. Easing only to the boundary
// leaves the subject sitting ON the trigger so the next tick re-fires — a permanent stream of micro-
// corrections, which is exactly the fidget this must avoid. `easePerTick` is the softness of that
// correction; 1.0 with zero dead zones reproduces a dead-centre turret and is a debug setting, not a look.
// `maxRateDegPerTick` stops a teleporting bot whipping the camera. `aimRise` aims at head/upper body.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SCOUT (`scout.*`) and OBS (`obs.*`)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The scout is the read-only headless observer that owns every raycast (the rig is pure RCON and has no
// world). Parked high, spectator, out of frame; `settleMs` skips raycasts after a re-park because a raycast
// into an unloaded chunk reads as empty air — a FALSE CLEAR. If it fails to connect the rig degrades to
// blind framing rather than stopping.
// OBS values are DECISIONS, which is why they are tracked here while OBS's own generated profile/scene
// files under tools/OBS are machine exhaust — gitignored, regenerated per box, never hand-synced.
// `container: hybrid_mp4` survives an unclean stop (plain mp4 corrupts). `encoder: auto` MEASURES what
// actually initialised on this machine rather than inferring from the GPU model. `capture.method 2` (WGC)
// keeps an OCCLUDED window rendering, which is what lets cameras be stacked on one monitor rather than
// tiled across three; `priority 1` matches by TITLE, which the window titler makes unique and stable.
// `recordMode 3` follows the main recording, so one StartRecord drives every per-camera file — NOT 1,
// which is "Always" and starts writing the instant the filter is created. `verifySeconds` is a CEILING on
// polling for real bytes on disk: issuing a command is not evidence it worked, and Source Record buffers,
// so files sit at 0 bytes for ~5-9s before the muxer flushes.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE ARCHITECT'S EYE (`architect.*`) — a camera the rig arms and then never touches
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// One more spectator client, built and launched exactly like a bot camera, that no director ever
// commands: a human flies it. `camName` is the ONE declaration of its name, and three separate
// consumers read it (the launcher builds the instance and titles the window, the rig arms it, OBS
// binds a capture and a Source Record filter to it) — a second copy anywhere is the value-used-to-
// check drifting from the value-used-to-act (Law 16). `enable` is the ONE declaration of whether it
// exists at all, read by the same consumers, for the same reason.
//
// WHY IT DEFAULTS OFF. This seat is the only one in the crew that produces nothing unless a human
// flies it for the whole run: every other camera is directed, and its footage exists whether anyone
// is watching or not. An unattended eye therefore costs a client, a window, a capture source and a
// recording filter, and returns a fixed shot of wherever it spawned — a cost with no product, which
// is what Law 13's default-stopped names. Turning it on is a launch-time switch on both the launcher
// and the conductors (`-Architect` / `--architect`) rather than a config edit, so a run that wants
// the seat asks for it and no run has to remember to undo it (Law 26 — an input authored while the
// machine is stopped). Editing `enable` to `true` here is the standing form of the same switch.
//
// IT IS ONE VALUE BECAUSE HALF-ARMING IT IS SILENT. The launcher building the instance and OBS
// binding its capture are separate acts by separate owners; if only one reads the switch, the failure
// is a window nobody records or a recording filter pointed at a client that never launched — neither
// throws, and both are discovered after the run. One declaration, every consumer, is what makes the
// off state actually off (Law 16).
//
// WHY IT IS ARMED BY THE RIG AND NOTHING ELSE. It needs the same two RCON lines a bot camera needs
// (spectator so it never falls or dies or blocks a mob, night vision so a night flight is usable),
// and camera arming already has exactly one owner. What makes it the ARCHITECT'S is that it never
// enters the rig's shot list — "no command is given to it" is then structural rather than a promise
// a future edit can quietly break (Invariant D: one owner, and here the owner is the human).
//
// It is a real player in spectator, which is the same citizenship every other camera already holds:
// spectators neither block spawns nor draw aggro, so the filmed run is the unfilmed run (Law 19 —
// the film crew observes, it does not act in the shared world).

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE HOST SEAT (`host.*`) — the client a human PLAYS, recorded with his voice on it
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A let's play has a presenter, and the presenter is a PLAYER — not a lens. This seat is therefore
// the one client in the whole stack that is neither directed nor armed: no spectator, no night
// vision, no shot list, no gimbal. It joins as an ordinary player under a real player name, it is
// captured like any other window, and its file is the only one in a take that carries a microphone.
//
// WHY IT IS NOT THE ARCHITECT'S EYE WITH A FLAG. The eye is a SPECTATOR — the rig sends it
// `gamemode spectator` at bring-up precisely so it can never fall, die, block a mob or change the
// world the run is measuring. A presenter must do all four: he mines, he builds, he dies, he hires a
// crew. The two seats differ in the one property that decides whether a client may act in the world
// at all, so they are two declarations rather than one with a mode (Law 27 — the seat's citizenship
// is part of what the seat IS, not a rule something has to enforce on it). The eye's exclusion from
// the shot list is expressed as an absence from `--bots`; the host's exclusion from the rig is one
// step stronger — it is passed to the rig on NEITHER list, so nothing in the director can address it.
//
// `playerName` IS A REAL NAME AND THAT IS LOAD-BEARING. Every contractor belongs to whoever asked
// for it: `foreman get` stamps the asker's name onto each bot it launches, and a crew raised under an
// invented name cannot be commanded by the real one afterwards. So the seat wears the name the server
// already knows and ops (`MinecraftServer/ops.json`), which is also what lets the presenter run
// `/time set day` or `/tp` from inside his own window. `proxy_human` reads the same name off the same
// ops list for the same reason.
//
// THE MICROPHONE TRAVELS ON A MIXER TRACK, AND THE FORM WAS MEASURED RATHER THAN READ.
// A Source Record filter writes its parent source's own audio unless it is told otherwise, and the
// obs-source-record build in `tools/OBS` gates that on TWO keys, not one: `audio_track: N` ALONE IS
// INERT — measured 2026-09-06, a filter carrying it wrote digital silence (-91.0 dB) while a 440 Hz
// tone assigned to that same mixer track reached the main recording at -21.1 dB in the same pass. It
// is `different_audio: true` that arms the track, and with both set the file carried the track exactly
// (-21.1 dB). So the host's window audio and the microphone are both assigned to `micTrack`, the
// host's filter reads that track, and every bot camera stays pinned to track 1 alone so no other
// window can bleed into the presenter's file. Naming a single source instead (`audio_source`) also
// works and is the wrong tool here: it carries one source, and this file needs two mixed.
//
// `micDevice` NAMES A DEVICE RATHER THAN TAKING WINDOWS' DEFAULT, and that is not fussiness. This
// machine reports eleven audio endpoints of which most are virtual (Steam Streaming Microphone,
// Virtual Desktop Audio, an Oculus headset) — devices that answer as a microphone and emit digital
// silence. A take recorded against the wrong one plays back perfectly and has no voice, which is
// discovered after the episode. `'default'` keeps OBS's own choice; any other value is the device's
// name as Windows reports it. `camera_obs.ps1 miccheck` is the assay, and it exists because no
// command return can prove a microphone is audible (Law 25).
//
// DESKTOP AUDIO STAYS MUTED WHETHER THIS SEAT IS UP OR NOT. "Just the client window and the
// microphone" is a constraint on what may reach a take, so the machine's own output — a browser, a
// notification, whatever else is open during a two-hour episode — is never in the set.
//
// OFF BY DEFAULT for the same reason the eye is: it produces nothing unless a human is in it.

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE TWO MODES (`mode.*`) and THE WITNESS (`witness.*`)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The scout client can answer two unrelated questions, and each has its own switch, toggleable
// independently so the whole camera system can stay off until recording is wanted:
//   framing — place and cut cameras. The film crew: cameras, gimbals, cuts, OBS.
//   witness — write the server's own account of every fight the fleet has. See camera/combat_witness.js.
// They share ONE scout client and ONE rcon link and are otherwise independent: either alone, both, or
// neither. BOTH DEFAULT OFF (Law 13 — default stopped, prove it should run). With both off the rig
// announces which keys to flip and exits rather than idling, because a process with no job is a zombie
// (Law 8). A witness with framing off never cuts a camera; it only borrows the eyes.
//
// The witness's numbers are all volume dials, bounding how much it writes so it cannot grow into an
// unreadable file. `sampleMs` is the rate WHILE A FIGHT IS OPEN and nothing else; an idle fleet writes zero
// lines regardless of it. `radius` is how far around an engaged bot the sample looks, deliberately wider
// than aggro range so the approach is on the tape. `noseRadius`/`nosePollMs` govern the RCON wide-area
// check, which only ever fires at a bot the scout cannot see. `maxRecords` is a runaway guard, not a
// quality knob, and hitting it is written into the record.

'use strict';

module.exports = {

  architect: {
    camName: 'Cam_Architect',
    enable:  false,
  },

  // The seat a human PLAYS from — see THE HOST SEAT above for why it is not the eye with a flag.
  host: {
    // The instance and window name. Prefixed `Cam_` deliberately even though it is not a camera:
    // every teardown, every titler match and every OBS window bind in this system identifies a
    // launched client by that prefix, and a seat outside the prefix is a window nothing reaps.
    // NAMED FOR WHAT THE SEAT IS, not for its role in a take: this is the client the Architect
    // himself drives and issues commands from, which is a different thing from `Cam_Architect` one
    // block above — that one is a SPECTATOR he flies and this one is a PLAYER he plays. The two
    // names sit next to each other on purpose, and the property that separates them is the one in
    // their declarations: the eye is armed to spectator, this seat is never armed at all.
    // NOT A WINDOW NAME WHEREVER THE SERVER IS BEING ASKED. `playerName` below is what the world
    // knows this seat as; this string is what Windows, the titler and OBS know it as. Handing the
    // window name to anything that talks to the server asks about an entity that cannot exist, and
    // nothing throws (see camera_rig's PRESENT-ONLY block).
    camName:    'Cam_Architect_Control',
    // The name the seat joins under. Must be a name the server ops (MinecraftServer/ops.json), or
    // the presenter cannot run a command from inside his own window and the crew he hires is
    // stamped to somebody who is not him.
    playerName: 'KaptainKrispyjr',
    enable:     false,
    // 'default' = whatever Windows hands OBS. Name a device to pin it — see the header on why the
    // default is a real hazard on a box carrying virtual microphones.
    micDevice:  'default',
    // Mixer track carrying [host window audio + microphone]. Track 1 is OBS's own recording track
    // and every other source sits on it; this is a second track so the presenter's file is the only
    // place the microphone ever lands. Range 2-6.
    micTrack:   2,
  },

  mode: {
    // OFF is the default and stays the default (Law 13 — prove it should run). A run that WANTS the
    // film crew turns it on for itself: camera_rig takes `--framing=on`, which is an input authored
    // while the machine is stopped (Law 26) rather than a config edit a session has to remember to
    // make and then remember to undo. Editing this to `true` is still legal for a hand-driven session;
    // nothing automated depends on it.
    framing: false,
    // OFF, and a trial run is the reason it stays off rather than a default guess. Turning the witness on
    // for a run and comparing its output against the commander's own post-mortem for the same fights found
    // its output unusable as it stands: it counted other camera clients as combatants, was kicked on
    // duplicate logins, and never successfully joined to the bot's own combat journal.
    //
    // NOT DELETED, and the distinction matters. The witness's premise is still sound — an outside lens
    // exists to CONTRADICT the bot's own claims, and nothing else in the fleet can. What the trial found
    // is that its join to the journal is broken, so it currently contradicts nothing. Fix the join before
    // turning it on again; turning it on as-is buys a second login and a file nobody can read against.
    witness: false,
  },

  witness: {
    sampleMs:   100,
    radius:     24,
    noseRadius: 16,
    nosePollMs: 2000,
    maxRecords: 120000,
  },

  timing: {
    minHoldMs:   5000,
    maxHoldMs:   15000,
    snapshotMs:  45000,
    droughtMs:   180000,
    logPollMs:   500,
    posPollMs:   1000,
  },

  frame: {
    undergroundY: 55,
    absorbRadius: 12,
    maxShotDist:  7,       // hard ceiling on camera→subject distance, every mode. It is also what SIZES the
                           //   ray budget below — see field.azSteps for why 7 implies 32 and not 64.
    camHeight:    1.5,     // THE LENS height above the bot's FEET — exact, not a floor. No elevation.
    // Eye height of the entity the picture is rendered FROM, and the reason every number above is now
    // honest. `tp` places a player by its FEET, and the camera client /spectate's the gimbal — so it
    // renders from the gimbal's EYE, 1.62 blocks higher. camHeight said "bot eye level, never above it"
    // and the lens sat at bot feet + 3.12: above the bot's head, looking DOWN through exactly the canopy
    // this whole file is arranged to avoid. Every raycast was cast from the feet plane too, so the tested
    // point and the rendered point were never the same point. solveView now reasons in LENS coordinates
    // end to end and sendCam subtracts this at the teleport, which is the only place feet are wanted.
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
      fovDeg:        70,     // must match the camera client's real VERTICAL FOV
      aspect:        16 / 9, // frame width / height — makes the tested region frame-SHAPED, not square
      frameFraction: 0.7,    // fraction of frame EXTENT certified clean (was a fraction of frame ANGLE)
      minHalfExtent: 0.9,
      maxHalfExtent: 10,
      // NO THRESHOLD. The gate is binary — every ray clear, or the candidate is rejected — so there is
      // nothing left to tune here and `minScore` is gone rather than left behind at a value nothing reads.
      // The fraction the cone still returns ranks the REJECTS for the always-return-a-shot fallback; it
      // decides nothing, which is why it needs no threshold. (It was flagged uncalibrated for two years of
      // this file's life; the honest resolution turned out to be removing the decision, not calibrating it.)
    },

    field: {
      // ── WHY 32, AND NOT 64 OR 16 ─────────────────────────────────────────────────────────────
      // A gap is only worth finding if a camera FITS in it, and with airBox 1 the camera needs a 3-block
      // opening. At the 7-block ceiling a 3-block gap subtends 2·atan(1.5/7) ≈ 24°, so to land a ray near
      // its MIDDLE rather than clipping its edge the spacing must be ≤ 12° — which is 32 azimuths (11.3°).
      // Finer only finds gaps too narrow to stand in: at 64 the spacing was 5.6° and half the rays were
      // re-confirming openings the previous ray had already found. The number is therefore DERIVED from
      // maxShotDist and airBox; change either and re-derive it rather than guessing.
      azSteps:   32,
      // ── THE LADDER ───────────────────────────────────────────────────────────────────────────
      // Ascending, and the ORDER IS LOAD-BEARING: the solver ranks by INDEX, so rung 0 must be the lowest.
      // At the 7-block ceiling these put the lens 1.5b / 3.3b / 5.0b above the bot's feet — eye level, a
      // slight rise, and a low-rooftop angle. The ceiling is where the old "never above eye level" taste
      // still lives: the preference for height is now unbounded-by-default and this list is the bound.
      elevs:     [0, 15, 30],
      margin:    2.0,        // stand this far short of what stopped the ray. IT MUST EXCEED `airBox`, and
                             //   that is arithmetic rather than taste: the camera parks exactly `margin`
                             //   from the blocker, and airClear(radius r) tests every cell within r — so
                             //   margin == airBox puts the blocker INSIDE the ball and rejects every
                             //   distance-limited direction by construction, leaving only rays that run
                             //   the full `maxShotDist + margin` clear. Under canopy that is almost none,
                             //   which is how a whole filmed run reached the fallback on every siting.
                             //   Read `margin > airBox` as the invariant; the values are its cheapest
                             //   satisfying pair.
      minUsable: 1,          // the practical MINIMUM shot distance — the floor of the envelope whose ceiling
                             //   is maxShotDist. A direction offering less clear room than this is skipped,
                             //   so the floor is a STARVATION dial, not a quality one: raise it and dense
                             //   interiors/canopy lose every azimuth at once and the boxed-in fallback runs
                             //   the shot instead — a worse picture than the close one the floor rejected.
                             //   Distance outranks height in the comparator, so a 1-block siting is only ever
                             //   chosen when nothing further exists; the anti-pocket load is carried by the
                             //   air box and the lens box, which the fallback also respects.
      airBox:    1,          // radius: 1 → a ~19-cell ball, 2 → ~81. BACK TO 1, and for the same room: a
                             //   radius-2 ball needs a 5-wide clear space, which no interior has. The lens
                             //   box now covers the forward near-field that radius 2 was bought for.
      // `topK`/`perRungK` — the cone budget and its per-rung split — are GONE with the ranked path they
      // fed (see ONE SEEKER). Nothing cones a candidate any more, so a budget for it would be config that
      // reads as a live dial and turns nothing (Law 16).
    },

    // THE LENS BOX — a clear rectangular tube straight out of the lens, `half` blocks to each side, over
    // depths `from`..`to` (clamped short of the subject: backdrop foliage is allowed). It covers the gap
    // between the air box (a small ball ON the camera) and the cone (a frustum anchored on the SUBJECT,
    // and therefore at its NARROWEST exactly where a leaf does the most damage). A leaf 3 blocks ahead
    // subtends ~19° of a 70° frame and nothing tested for it. Block lookups only — no rays.
    lensBox: { half: 1, from: 2, to: 5 },

    seek: {
      improve:     0.12,
      minRoomGain: 4,
    },

    // WHAT IS LEFT OF THE WEIGHTS. distFit / lowAngle / variety / room are GONE — not disabled, gone, because
    // a weighted sum is the wrong shape for a strict priority order and dead config is a trap that reads as a
    // live dial. `approach` survives without a weight: it is now the third comparator key (break the tie that
    // rung-then-distance leaves), and a tiebreak has no magnitude to tune.
    weights: {
      preferredDist:       7,
      minBearingChangeDeg: 30,
    },

    objective: {
      idleDroughtMs:      8000,
      arrivalRadius:      5,
      travelDistance:     8,    // clamped to maxShotDist; see wide.distance
      travelCutMinDist:   5,
      travelStageMaxDist: 40,   // longer leg → follow the bot instead of waiting at an empty destination
      travelMaxHoldMs:    90000,
    },

    // The see-through (underground) shot — a frozen tripod, no cone, no gimbal. See the section above.
    enclosed: {
      jobPrefixes: ['mine/'],   // job names whose starved search means ROCK, not thicket
      distance:    7,           // camera→bot, the pre-seeker framing
      // REBASED, NOT RETUNED. This is a LENS height above the bot's feet, like camHeight — but it was
      // written when the value was fed straight to `tp`, i.e. as FEET, so the shot that was actually
      // judged on screen rendered from 2.1 + eyeHeight = 3.72. Carrying 2.1 through the eye-height fix
      // would have quietly flattened a framing nobody asked to change, so the number moved to keep the
      // picture still. It is an honest dial now: lower it if the down-look is too steep.
      rise:        3.72,        // LENS height above the bot's FEET — the down-look, not the camera plane
    },

    wide: { distance: 9 },   // clamped to maxShotDist like every other mode — kept as its own dial so the
                             //   ceiling can rise later without the wide shot silently staying short
    bot:  { aimRise: 0.6, minFramedDist: 2 },   // tracks minUsable: the boxed-in fallback must be able to
                                                //   place a shot anywhere the main path could
  },

  hold: {
    checkHz:           4,
    frameExitDeg:      30,      // frozen-aim fallback only; skipped when a gimbal is live
    maxSubjectDist:    40,
    exitGraceMs:       1500,    // frozen-aim fallback only
    heartbeatMs:       1000,
    occlusionCheckMs:  5000,    // re-test the FRAME (the 117-ray cone) this often DURING a hold
    reoccludeScore:    0.35,    // below this (or centre ray blocked) the shot is spoiled → cut
    // THE SUBJECT-LOST CUT, and it is deliberately not on the same clock as anything else. The gimbal's
    // sightline walk answers "is the bot visible AT ALL" twice a second, and a shot whose subject has gone
    // behind a trunk has no value from that instant on (Architect: "theres no point of recording leaves…
    // it adds no value so teleporting the camera often is better than slowly and waiting for timers").
    // So this cut ignores minHoldMs entirely and honours only the floor below — which exists solely to stop
    // a re-cut that also lands blocked from machine-gunning. It is a rate limit, not a rhythm; every other
    // hold rule in this file is a rhythm, and confusing the two is how this becomes another timer to wait on.
    blockedMinHoldMs:  1200,
    // A "cut" that lands the lens within this of where it already stands is not a cut — it is a re-tp to the
    // same spot, invisible on screen and a lie in the trace. A spoiled travel shot can otherwise re-solve
    // back to its own destination and log a run of identical CUTs that never actually moved the camera.
    sameShotDist:      1.0,
    // ── THE THRASH GUARD — a shot that dies on arrival buys first person, not another shot ──────────
    // A cut that is blocked almost immediately is not a bad shot, it is a bad MOMENT: the bot is walking,
    // and every vantage the seeker can reach right now will be behind the same trunk a second later. Cutting
    // again there produces the fast switching that makes a long navigation leg unwatchable — the seeker
    // working exactly as designed, once per second, at the one time its answer cannot hold.
    //
    // So: if the sightline goes down within `thrashWindowMs` of the cut, the answer is first person for
    // `thrashFirstPersonMs`, then a normal re-check. First person is the right stopgap for the same reason
    // it answers a 1-block corridor — it cannot be occluded from its own subject, so it is the one framing
    // guaranteed to survive a moment that defeats every placement.
    //
    // THE WINDOW IS MEASURED FROM WHEN THE BLOCK BEGAN, not from when the cut fires. `blockedMinHoldMs`
    // delays the cut by 1.2s, so timing this off the cut would silently shrink the window to the sliver
    // between the two numbers and the rule would almost never fire.
    thrashWindowMs:      2000,
    thrashFirstPersonMs: 5000,
  },

  gimbal: {
    enable:            true,
    prefix:            'Gim_',
    deadzoneYawDeg:    22,
    deadzonePitchDeg:  12,
    recenterFrac:      0.35,
    easePerTick:       0.12,
    maxRateDegPerTick: 6,
    aimRise:           1.2,
    // THE WATCH (camera_gimbal walks its own sightline — see that file's header for why it, and not the
    // scout, is the client that should). `occlusionMs` is the sample period; `graceChecks` is how many
    // CONSECUTIVE blocked samples the rig is told about. At 500 ms the period is already the debounce, so
    // 1 is "cut as fast as we can tell" — raise it to 2 if a bot walking a treeline produces cuts you feel.
    occlusionMs:       500,
    graceChecks:       1,
  },

  scout: {
    enable:       true,
    username:     'Scout_Cam',

    // ── WHERE THE EYES STAND, AND WHY IT IS DIRECTLY OVERHEAD ──────────────────────────────────
    // A loaded chunk is a FULL COLUMN — 16×16 from world bottom to build height. Altitude therefore
    // costs nothing and buys nothing in loading terms; only the HORIZONTAL chunk coordinate decides
    // what the scout can read. So the one thing that matters is that its view distance is centred on
    // the subject, and the cheapest way to guarantee that is to stand on the subject's own column.
    //
    // WHAT IT REPLACES. The scout used to park at the CENTROID of every bot at a fixed y=120, and
    // re-anchor only after that centroid drifted 32 blocks. Two failures came out of that, both of
    // which end in a blind shot rather than a bad one:
    //   · with bots apart, the centroid is where NOBODY is — the subject could sit near or past the
    //     edge of view distance, castVisibilityField returns { known:false }, and the seeker falls
    //     through to `blind (field not ready)`.
    //   · the same drift takes the scout out of ENTITY tracking range of the bot, and entity range is a
    //     separate budget from chunk loading: a client can hold a chunk and still not be sent the PLAYER
    //     standing in it, at which point entityPos returns null and even the position read falls back to
    //     RCON polling. The tracking test is a HORIZONTAL box — |dx| and |dz| against the effective
    //     range, with y not examined — so altitude never costs tracking and the centroid's horizontal
    //     drift is the whole of the exposure.
    // Both are fixed by the same move, and by the horizontal half of it in both cases: standing on the
    // subject's own column puts dx=dz≈0, which is inside any tracking range a server can be configured
    // with rather than inside the one this server happens to use. `parkRise` is then free to be chosen
    // for the only thing altitude still decides — staying out of frame — and 20 clears a 70° lens
    // pointed at the bot from any shot distance the rig will take.
    //
    // (An earlier version of this note said the fixed y=120 was itself outside entity tracking range.
    // That was asserted, not checked, and the axis test above is why it is wrong: 56 blocks of pure
    // vertical separation costs nothing. The horizontal reason is the real one and it is what the code
    // was already written against, so nothing moved but this paragraph.)
    parkRise:     20,     // blocks directly ABOVE the subject being scanned
    parkRadius:   48,     // re-park once the subject is this far off the current column (well inside
                          //   view distance, so the common case is no teleport at all)
    height:       120,    // fallback altitude for the witness-only centroid park (no framing subject)
    reanchorDist: 32,
    // Upper bound on the wait after a re-park, NOT a fixed cost: the rig polls the scout for the
    // subject's own cell and proceeds the moment it reads, which is usually far sooner. It only spends
    // the whole budget when chunks genuinely are not streaming — and then a blind shot, not a hang, is
    // what it degrades to.
    settleMs:     2500,
    // How long a ray loop may run before ceding a macrotask (voxel_scan_throttle). WELL under the 50 ms
    // one-tick default on purpose: a full-tick slice is one full tick in which this client's packet
    // handlers cannot fire, and a tick is the unit the combat record measures in. A smaller slice yields
    // control more often, so inbound packets get heard sooner, at the cost of the raycast solve taking
    // longer to finish. Camera cuts are paced on the order of seconds, so trading solve speed for packet
    // responsiveness here is free — raising this makes a frame solve finish sooner and the witness deafer,
    // in that proportion.
    scanSliceMs:  8,
  },

  obs: {
    profileName:   'AurenCameras',
    sceneName:     'AurenCameras',
    filterName:    'AurenSourceRecord',
    outputDir:     'footage',
    container:     'hybrid_mp4',
    // BITRATE is sized for UPLOAD, not for archival: a mastering-grade bitrate produces files far too large
    // to upload quickly, and a long video must not cost hours to upload. YouTube re-encodes everything on
    // ingest and recommends 12000 for 1080p60 SDR, so anything above that is bits thrown away twice.
    // 10000 sits under that: Minecraft is flat-shaded with no film grain, the cheapest content a
    // modern encoder ever sees, and NVENC on this box is well inside transparency at this rate.
    // Raise it only if a judged frame shows real blocking artefacts — not on suspicion.
    bitrateKbps:   10000,
    // THE MAIN OBS RECORDING IS A TRIGGER, NOT FOOTAGE — and it is sized and filed as one.
    // The per-camera Source Record filters run in "Recording" mode, meaning they write only while
    // OBS's own recording is active. That is what makes ONE `start` enough for N cameras, so the
    // main output cannot simply be switched off; but its FILE is pure by-product. Left at the
    // deliverable bitrate it duplicates whichever camera sits topmost in the scene at full size —
    // measured on the first three-camera take: 1.8 GB of exact duplicate per run, the largest single
    // file of the four.
    // Two settings that are provably isolated from the deliverables, because each Source Record
    // filter carries its OWN path and bitrate, set explicitly and separately:
    //   dir  — keeps the by-product out of the folder the clipper and the editor read, so `footage/`
    //          holds only files that are footage.
    //   bitrateKbps — the trigger is never watched by anyone. Nothing reads it, so quality in it is
    //          waste by definition. Resolution is deliberately NOT lowered here: bitrate provably
    //          governs only this output, whereas the canvas is what every capture is sampled at.
    trigger:       { dir: 'footage/_trigger', bitrateKbps: 400 },
    canvas:        { width: 1920, height: 1080, fps: 60 },
    encoder:       'auto',
    // WGC window capture can also take the WINDOW*S* OWN AUDIO, and does not by default — which is why
    // every take filmed before 2026-08-20 carries an AAC track measuring -91 dB mean AND max from end
    // to end: a real stream, containing digital silence. Nothing downstream could tell, because a silent
    // track is indistinguishable from a quiet one until something tries to duck under it.
    //   audio        — capture_audio, the WGC flag that makes the source produce sound at all.
    //   audioPerCam  — reroute_audio, which keeps that sound ON THE SOURCE instead of merging it into
    //                  desktop audio. It is what makes N cameras N soundtracks: each bots file then
    //                  carries the world as heard AT THAT BOT, matching the picture it is cut against.
    //                  Merged desktop audio would give every camera the same mix of all N clients,
    //                  which is not a soundtrack, it is a crowd.
    // MUSIC IS NOT SILENCED HERE. It is silenced in the CLIENT (start_cameras.ps1 sets
    // soundCategory_music and soundCategory_record to 0.0 on every camera, every launch), because a
    // camera that cannot emit licensed music cannot leak it into a take no matter what OBS is doing.
    // Turning it off at this layer instead would put the copyright guarantee behind a setting that is
    // one forgotten re-configure away from being wrong.
    capture:       { method: 2, priority: 1, audio: true, audioPerCam: true },
    sourceRecord:  { recordMode: 3 },
    websocketPort: 4455,
    verifySeconds: 15,
  },
};
