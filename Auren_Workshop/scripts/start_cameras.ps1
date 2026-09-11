# Start the camera crew - one spectator game window per bot + the camera_rig director.
#
# Everything is automated except ONE one-time step: the first run opens Prism Launcher's
# window so you can add your Microsoft account (Accounts -> Manage Accounts -> Add Microsoft,
# log in with the account that owns Minecraft). That single login proves ownership; after it,
# the camera windows join the local server under made-up names (Cam_AurenBot, Cam_TessaBot)
# because the server runs offline-mode - no extra accounts, no extra purchases, ever.
#
# What this script does, in order, every time:
#   1. Finds Prism Launcher (portable, in tools\PrismLauncher). Downloads it if missing.
#   2. Reads the server's Minecraft version from its log (currently 1.21.5) and creates one
#      launcher instance per camera, pinned to that version. Re-run safe: existing instances
#      are kept, version drift is corrected automatically after a server upgrade.
#   2b. Copies your MAIN game's RESOURCE packs (from %APPDATA%\.minecraft) into every camera and
#      enables them, so the footage matches your live game. Textures only - the instances are
#      plain vanilla with no mod loader and no shaders (see the pack write for why).
#   3. Checks you've done the one-time account login; if not, opens Prism and tells you what
#      to click, then exits. Re-run after logging in.
#   4. Launches the camera windows (they auto-join 127.0.0.1) and starts camera_rig.js,
#      which flips them to spectator + night vision and starts directing shots.
#   5. Starts a background window titler (camera_window_titler.ps1) that renames each camera
#      window to its cam name (Cam_AurenBot, ...). Without this every window is titled the
#      identical "Minecraft <ver>", so OBS can't tell them apart and reattaches to the wrong one
#      after a restart. Unique titles let ONE OBS instance lock a Window Capture per camera.
#
# Usage:
#   .\start_cameras.ps1              -> 2 cameras (whole fleet) + director
#   .\start_cameras.ps1 -Count 1     -> 1 camera (AurenBot only) + director
#   .\start_cameras.ps1 -Bots A,B    -> cameras for exactly these bots (the foreman picks the names)
#   .\start_cameras.ps1 -SetupOnly   -> install/prepare everything, launch nothing
#   .\start_cameras.ps1 -Framing     -> launch the director with framing ON (config default is off)
#   .\start_cameras.ps1 -Architect   -> add the seat you fly yourself (config default is off)
#   .\start_cameras.ps1 -HostSeat    -> add the seat you PLAY (config default is off) - a let's play
#   .\start_cameras.ps1 -Bots A,B -Add -HostSeat
#                                    -> CONVERGE on that set: launch only what is missing, restart
#                                       the director and titler over all of it. Safe to repeat.
#   .\start_cameras.ps1 -Down        -> stop the camera clients and the director this script started
#
# NOTE the switch is -HostSeat and not -Host: $Host is a PowerShell automatic variable (the host UI
# object), so a parameter of that name would shadow it inside this script.
#
# After the windows open: click into each one, press F1 (hides the hotbar - clean footage). The
# titler names each window Cam_<Bot>, so in ONE OBS instance add a Window Capture per camera
# (method "Windows 10 (1903+)", priority "Match title") and it locks to the right window even
# after a restart -- no per-bot OBS, no re-picking. Window Capture (not Display Capture) is right
# here: it grabs a specific window regardless of position/overlap (pauseOnLostFocus:false keeps
# background windows rendering), so 4 cameras across 3 mismatched monitors need no tidy layout.
# Use the Source Record plugin to write each source to its own per-bot file from that one OBS.
# The rig window narrates every shot change (WIDE -> TUNNEL etc.) so you can see it working.

param(
    [int]$Count = 0,              # 0 = whole roster (one camera per bot); pass 1 or 2 for a subset
    [string]$Bots = '',           # EXACT bot names, comma-separated - overrides -Count. See -Add.
    [string]$McVersion = '',      # blank = auto-detect from the server log
    [switch]$SetupOnly,
    [switch]$Framing,             # launch the director with framing ON regardless of camera_configure
    [switch]$Architect,           # add the seat a human flies (OFF by default - see the eye section)
    [switch]$HostSeat,            # add the seat a human PLAYS (OFF by default - see the host section)
    [switch]$Add,                 # CONVERGE: launch only what is missing, restart director + titler
    [switch]$Down                 # reap the crew this script raises (Law 8) - see the -Down section
)

# ---- -Bots and -Add: raising a camera for a bot that did not exist when the run started -------
#
# WHY THIS SCRIPT NEEDED A SECOND SHAPE. It was written for a crew whose size is known before the
# world starts: -Count N, N windows, one director, done. A CONTRACTOR run is the opposite - the world
# comes up with zero bots and a person in the game says "foreman get", so which bots exist, and how
# many, is not knowable until somebody asks. A camera per bot then has to be raisable mid-run.
#
# -Bots NAMES THE SET instead of counting into the roster, because the foreman hands out whatever
# names are free rather than the first N in seniority order. -Count is untouched and still means what
# it meant.
#
# -Add MAKES THE CALL CONVERGENT rather than additive, and that is deliberate: the caller passes the
# WHOLE set it wants standing and this launches only the clients that are not already running, then
# restarts the director and the titler over the full set. That is the same property `camera_obs up`
# has and it is the reason both are safe to call repeatedly - a converging call is its own repair
# path, while an additive one has to be told exactly what changed and is wrong the moment a client
# died in between (Invariant B - re-sense the set, never track it).
#
# THE DIRECTOR AND THE TITLER ARE RESTARTED, NOT EXTENDED, AND THAT IS THE HONEST TRADE. Both take
# their roster as a launch argument and neither re-reads it, so a late camera is invisible to a
# director that is already running: it would never be armed to spectator and never cut to. Restarting
# them costs a gap of a few seconds in camera MOVEMENT and costs the recording nothing at all - OBS
# holds the windows, not the director, so every file keeps writing across the restart. The rejected
# alternative was teaching the rig to poll a roster file: a live re-read inside a 1,600-line director
# that is mid-cut is a much larger change with a much worse failure mode than a restart whose cost is
# visible and bounded.

# ---- The Architect's eye: the seat nothing directs, and only when asked for -------------------
# One more instance, built and launched exactly like a bot camera and titled the same way, that is
# NOT passed to the director. It reaches the rig only through --freecams, which arms it (spectator +
# night vision) and then sends it nothing for the rest of the run. The exclusion is what makes it the
# Architect's, so it is expressed as an absence from --bots rather than as a rule inside the rig that
# a later edit could weaken.
#
# OFF BY DEFAULT, because it is the one seat in the crew that produces nothing unless a human flies it
# for the whole run - every other camera is directed and its footage exists whether anyone is watching
# or not (Law 13; the full reasoning lives once, in camera_configure's architect section). -Architect
# turns it on for this launch; architect.enable in camera_configure turns it on standing.
#
# THE SWITCH MUST ALSO REACH OBS. This script raises the window, camera_obs binds the capture, and a
# disagreement between them is silent in both directions - an unbound window renders and records
# nothing, and a capture bound to a client that never launched reports a clean start over a black file.
# Nothing throws either way. Callers that raise both (record_overlay) pass the same value to both.
#
# ---- -Down: the missing half of Law 8 ---------------------------------------------------------
# This script raises three things no other teardown knows about - the camera clients, a director, and a
# titler - and `fleet_control down` reaps none of them, so before this existed every filmed run left
# camera windows and a director standing. Whatever a run raises, that run reaps.
# Matching is by COMMAND LINE, the same discriminator the titler already uses: a camera's java process
# carries its instance name and the director's processes carry camera_rig.js. Process order and window
# titles are not identity here (the titler's header has the long form of why).

# THREE HOPS TO THE REPO ROOT, not two (2026-09-10): the workshop moved inside the bot, so
# scripts -> Auren_Workshop -> Auren_Bot -> repo root. `tools\PrismLauncher` (the 1.1 GB camera crew)
# is the Architect's own equipment at the repo root; looked for under `Auren_Bot/` this script would
# decide Prism was not installed and offer to download it again. The server folder is NOT computed here:
# it is the workstation resolver's answer, asked once node is resolved below.
$scriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$workshopDir  = Split-Path -Parent $scriptDir
$botRoot      = Split-Path -Parent $workshopDir
$repoRoot     = Split-Path -Parent $botRoot
$toolsDir     = Join-Path $repoRoot 'tools'
$prismDir     = Join-Path $toolsDir 'PrismLauncher'
$prismExe     = Join-Path $prismDir 'prismlauncher.exe'
$fleetControl = Join-Path $workshopDir 'fleet_control.js'

# ---- -Down: reap what this script raises, and nothing else -----------------------------------
# Runs before the roster is even read: a teardown that needed node, a roster and a server would be
# unavailable in exactly the situation it is most wanted (a half-dead run). Every camera instance
# lives under ...\instances\Cam_<name>\, so one pattern covers the bot cameras and the Architect's
# eye without either being enumerated here.
# The titler is not killed and must not be: it watches for the windows and exits on its own the pass
# after the last one goes (its Law 8 clause). Killing it would race that and prove nothing.
if ($Down) {
    $killed = 0
    # The director first, so it cannot narrate at, or teleport, a camera that is on its way out.
    # Both the -NoExit powershell host and its node child carry camera_rig.js on their command line;
    # killing the pair is what leaves no empty console window behind.
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%camera_rig.js%'" -ErrorAction SilentlyContinue)) {
        if ($proc.ProcessId -eq $PID) { continue }
        Write-Host "  stopping director pid $($proc.ProcessId) ($($proc.Name))"
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
    }
    # THE SLASH IS THE WHOLE BUG THIS SHAPE PREVENTS. The filter was a single WQL LIKE on
    # '%instances\Cam_%' and matched NOTHING, because Prism writes the instance path into the java
    # command line with FORWARD slashes (-Djava.library.path=.../instances/Cam_AurenBot/natives) even on
    # Windows. Measured 2026-08-16: a teardown reported "2 process(es) stopped" - the director only - and
    # left four game windows running while claiming the crew was down (Law 25: the count is what made it
    # a lie rather than a miss). So the coarse set comes from WQL and the identity test is a regex that
    # accepts either separator; no path string in this file may assume a slash direction again.
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name LIKE 'java%'" -ErrorAction SilentlyContinue |
                        Where-Object { $_.CommandLine -match 'instances[\\/]Cam' })) {
        Write-Host "  stopping camera client pid $($proc.ProcessId)"
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
    }
    # Report what was actually found, never a bare success: a teardown that reaped nothing because it
    # matched nothing must not read the same as one that reaped a full crew (Law 25).
    if ($killed -eq 0) {
        Write-Host 'Camera crew down: nothing was running to stop.'
    } else {
        Write-Host "Camera crew down: $killed process(es) stopped. The titler exits on its own once the windows are gone."
    }
    exit 0
}

# Resolved up-front because the roster is read from fleet_control.js (the single source of truth,
# Law 16) rather than a hand-mirrored array — adding a bot to BOT_SENIORITY in architect_config.js is
# the only edit, and this list follows automatically.
. "$PSScriptRoot\_node.ps1"   # the one node resolver (Law 16)
$node = Get-AurenNode
# The server folder whose latest.log is read below - the workstation resolver's answer (Law 16).
$serverDir = & $node (Join-Path $botRoot 'js_kernel\utils\workstation.js') server

# Roster in seniority order — Cam_<Bot> windows map 1:1 onto these names.
$Roster = @(((& $node $fleetControl roster) | Select-Object -Last 1).Trim() -split ',')
if (-Not $Roster -or $Roster.Count -lt 1 -or $Roster[0] -eq '') {
    Write-Host 'Could not read the roster from fleet_control.js.'; exit 1
}

if ($Count -lt 1) { $Count = $Roster.Count }          # 0/unset = one camera per roster bot
if ($Count -gt $Roster.Count) { $Count = $Roster.Count }

# The bot cameras, and then the seat nobody directs. $BotCams is what the director is told about;
# $CamList is every window that gets built, launched and titled. Keeping them as two lists is the whole
# mechanism of the Architect's eye - the director simply never learns the extra name.
#
# WHEN THE EYE IS OFF the two lists are identical, and every consumer below reads $CamList - so the off
# state removes the window, its title, its options patch and its --freecams entry in one place rather
# than in five branches (Law 16).
# -Bots names the set outright; -Count keeps its old meaning (the first N in seniority order). A name
# that is not on the roster is REFUSED rather than skipped: it would silently produce a crew one camera
# short of the one that was asked for, and the shortfall is only discovered in the footage (Law 25).
# AN EMPTY -Bots IS A REAL ANSWER when the parameter was actually passed, and -Count 0 already means
# "the whole roster" — so the two cannot be told apart by the value alone. A let's play comes up with
# NO bot cameras (the crew is hired in chat later, and the warden raises their cameras then), and a
# caller that said `-Bots ''` and got all twenty-two windows would be the opposite of what it asked
# for. PSBoundParameters is what distinguishes "told, and the answer is none" from "not told".
if ($PSBoundParameters.ContainsKey('Bots')) {
    $BotNames = @($Bots.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    $unknown  = @($BotNames | Where-Object { $Roster -notcontains $_ })
    if ($unknown.Count -gt 0) {
        Write-Host "Not on the roster: $($unknown -join ', '). Known bots: $($Roster -join ', ')"
        exit 1
    }
} else {
    $BotNames = @($Roster[0..($Count - 1)])
}
$BotCams = @($BotNames | ForEach-Object { "Cam_$_" })
# Read from camera_configure.js rather than repeated here: three consumers share this name and a copy in
# a launcher is the one that drifts silently (Law 16). Forward slashes because the value goes inside a
# JS string literal. `enable` travels the same way, so -Architect is an override of a declared default
# rather than the only way to ask for the seat.
$cfgPath = ($workshopDir -replace '\\', '/') + '/camera/camera_configure.js'
$ArchitectCam = (& $node -p "require('$cfgPath').architect.camName").Trim()
if (-not $ArchitectCam) {
    Write-Host 'Could not read architect.camName from camera/camera_configure.js.'; exit 1
}
$ArchitectOn = $Architect.IsPresent -or ((& $node -p "!!require('$cfgPath').architect.enable").Trim() -eq 'true')

# ---- The HOST SEAT: read from the same one declaration, for the same reason -------------------
# Its name, the player name it joins under and its on/off state all live in camera_configure (the
# full reasoning is in that file's HOST SEAT section). Three consumers read them - this launcher
# builds and titles the window, camera_obs binds its capture and routes the microphone into its file,
# and the DIRECTOR deliberately never hears of it at all. That last one is the whole difference
# between this seat and the Architect's eye: the eye is passed on --freecams, which arms it to
# spectator; a presenter must be able to mine, build, die and hire a crew, so it is passed on NEITHER
# list and nothing in the rig can address it.
$HostCam    = (& $node -p "require('$cfgPath').host.camName").Trim()
$HostPlayer = (& $node -p "require('$cfgPath').host.playerName").Trim()
if (-not $HostCam -or -not $HostPlayer) {
    Write-Host 'Could not read host.camName / host.playerName from camera/camera_configure.js.'; exit 1
}
$HostOn = $HostSeat.IsPresent -or ((& $node -p "!!require('$cfgPath').host.enable").Trim() -eq 'true')

$CamList = @($BotCams)
if ($ArchitectOn) { $CamList += $ArchitectCam }
if ($HostOn)      { $CamList += $HostCam }

# The player name each window joins under. Every camera wears its own cam name - they are invented
# names on an offline-mode server and nothing depends on them beyond being unique. The host wears a
# REAL one, and that is load-bearing rather than cosmetic: `foreman get` stamps the asker's name onto
# every contractor it launches, so a presenter joined under an invented name would hire a crew that
# answers to somebody who is not him, and could not run a command from inside his own window either.
function Get-PlayerName([string]$cam) { if ($cam -eq $HostCam) { return $HostPlayer } return $cam }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Patch a single key in a Minecraft options.txt (create/replace the line, keep the rest).
function Set-OptionLine([string]$File, [string]$Key, [string]$Value) {
    $lines = if (Test-Path $File) { @(Get-Content $File) } else { @() }
    $set = $false
    $out = foreach ($l in $lines) {
        if ($l -match "^$([regex]::Escape($Key)):") { $set = $true; "${Key}:${Value}" } else { $l }
    }
    if (-not $set) { $out = @($out) + "${Key}:${Value}" }
    [IO.File]::WriteAllText($File, ($out -join "`n") + "`n", $utf8NoBom)
}

# Hand a key back to the game: delete the line so Minecraft writes its own default on next launch.
# Needed as its own verb because there is no value that means "unset" - writing any number is still
# this script deciding, and the whole point of releasing a key is that the game decides it (Law 26 -
# never author what the machine owns). Deleting is also the only form that reaches instances an
# earlier revision already pinned; a create-only change would leave them pinned while looking released.
function Remove-OptionLine([string]$File, [string]$Key) {
    if (-not (Test-Path $File)) { return $false }
    $lines = @(Get-Content $File)
    $out   = $lines | Where-Object { $_ -notmatch "^$([regex]::Escape($Key)):" }
    if ($out.Count -eq $lines.Count) { return $false }
    [IO.File]::WriteAllText($File, ($out -join "`n") + "`n", $utf8NoBom)
    return $true
}

# instance.cfg is Prism's own INI (key=value), not options.txt (key:value) — hence a second setter.
function Set-InstanceCfgLine([string]$File, [string]$Key, [string]$Value) {
    $lines = if (Test-Path $File) { @(Get-Content $File) } else { @() }
    $set = $false
    $out = foreach ($l in $lines) {
        if ($l -match "^$([regex]::Escape($Key))=") { $set = $true; "${Key}=${Value}" } else { $l }
    }
    if (-not $set) {
        # Keys belong under [General]; append there rather than after a trailing section.
        if ($out -contains '[General]') {
            $out = foreach ($l in $out) { $l; if ($l -eq '[General]') { "${Key}=${Value}" } }
        } else {
            $out = @('[General]', "${Key}=${Value}") + $out
        }
    }
    [IO.File]::WriteAllText($File, ($out -join "`n") + "`n", $utf8NoBom)
}

# ---- Step 1: Prism Launcher (portable, lives inside the repo's tools folder) --------------
if (-not (Test-Path $prismExe)) {
    # Also accept a normally-installed Prism before downloading anything.
    $installed = Join-Path $env:LOCALAPPDATA 'Programs\PrismLauncher\prismlauncher.exe'
    if (Test-Path $installed) {
        $prismExe = $installed
        $prismDir = Split-Path -Parent $installed
        Write-Host "Using installed Prism Launcher: $prismExe"
    } else {
        Write-Host 'Prism Launcher not found - downloading the portable build (one time)...'
        try {
            $rel = Invoke-RestMethod 'https://api.github.com/repos/PrismLauncher/PrismLauncher/releases/latest' `
                       -Headers @{ 'User-Agent' = 'Auren-camera-rig' }
            $asset = $rel.assets | Where-Object { $_.name -match 'Windows-MSVC-portable' -and $_.name -notmatch 'arm64' -and $_.name -match '\.zip$' } | Select-Object -First 1
            if (-not $asset) { throw 'no Windows portable zip in the latest release' }
            $zip = Join-Path $env:TEMP $asset.name
            Write-Host "  $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)"
            Invoke-WebRequest $asset.browser_download_url -OutFile $zip -Headers @{ 'User-Agent' = 'Auren-camera-rig' }
            New-Item -ItemType Directory -Force $prismDir | Out-Null
            Expand-Archive $zip -DestinationPath $prismDir -Force
            Remove-Item $zip
            Write-Host "  Installed to $prismDir"
        } catch {
            Write-Host "Automatic download failed ($($_.Exception.Message))."
            Write-Host 'Manual fallback: https://prismlauncher.org/download/ - pick "Portable (zip)",'
            Write-Host "extract into $prismDir so prismlauncher.exe sits directly inside, then re-run."
            exit 1
        }
    }
}

# Portable Prism keeps its data next to the exe; an installed one uses %APPDATA%.
$prismData = $prismDir
if (-not (Test-Path (Join-Path $prismDir 'portable.txt'))) {
    $appdataPrism = Join-Path $env:APPDATA 'PrismLauncher'
    if (Test-Path $appdataPrism) { $prismData = $appdataPrism }
}

# ---- Step 2: match the server's Minecraft version and build the camera instances ----------
if ($McVersion -eq '') {
    $logFile = Join-Path $serverDir 'logs\latest.log'
    if (Test-Path $logFile) {
        $verLine = Select-String -Path $logFile -Pattern 'Starting minecraft server version (\S+)' | Select-Object -First 1
        if ($verLine) { $McVersion = $verLine.Matches[0].Groups[1].Value }
    }
    if ($McVersion -eq '') {
        Write-Host 'Could not detect the server version from its log - pass it explicitly:'
        Write-Host '  .\start_cameras.ps1 -McVersion 1.21.5'
        exit 1
    }
}
Write-Host "Camera clients will run Minecraft $McVersion (matched to the server)."

$instancesDir = Join-Path $prismData 'instances'
New-Item -ItemType Directory -Force $instancesDir | Out-Null

# Your main game's resource packs (copied into every camera so footage matches your live game).
# Textures only, never shaders: a resource pack costs VRAM once at load, while a shader pack costs
# GPU time on every frame AND spikes hard whenever chunks build -- and N cameras multiply that cost
# by N. The instances are therefore plain vanilla with no mod loader (see the pack write below).
$mainMc      = Join-Path $env:APPDATA '.minecraft'
$srcResource = Join-Path $mainMc 'resourcepacks'

foreach ($cam in $CamList) {
    $instDir = Join-Path $instancesDir $cam
    $mcDir   = Join-Path $instDir '.minecraft'
    New-Item -ItemType Directory -Force $mcDir | Out-Null

    # ---- The pack: PLAIN VANILLA, one component, no mod loader ---------------------------------
    # Rebuilt when the MC version drifted OR the instance still carries a mod loader. The second
    # half of that test is a MIGRATION, not a toggle: a camera built by an older revision of this
    # script has Fabric components in its pack and mod jars on disk, and it would keep launching
    # modded forever otherwise (nothing else owns this file - Invariant D). Both are cleared below.
    $packFile   = Join-Path $instDir 'mmc-pack.json'
    $raw        = if (Test-Path $packFile) { Get-Content $packFile -Raw } else { '' }
    $haveLoader = $raw -match 'fabric-loader'
    $haveVer    = $raw -match [regex]::Escape("""$McVersion""")
    if (-not $haveVer -or $haveLoader) {
        $comps = '{"important":true,"uid":"net.minecraft","version":"' + $McVersion + '"}'
        [IO.File]::WriteAllText($packFile, '{"formatVersion":1,"components":[' + $comps + ']}', $utf8NoBom)
    }
    # A vanilla launch ignores mods/ and shaderpacks/, but leaving them means the next reader cannot
    # tell what this instance actually runs, and a hand-flip of the pack silently revives the whole
    # stack (Invariant C). Delete on sight so the disk states one truth.
    # ANNOUNCED ONLY WHEN IT HELD SOMETHING. Vanilla Minecraft recreates both folders EMPTY on every
    # launch, so an unconditional line would report a migration on every run of every camera forever -
    # and the one run where a real mod stack was actually cleared would look identical to the noise
    # (Law 25: a message that fires when nothing happened teaches the reader to skip the one that matters).
    foreach ($dead in @('mods', 'shaderpacks')) {
        $deadDir = Join-Path $mcDir $dead
        if (-not (Test-Path $deadDir)) { continue }
        $held = @(Get-ChildItem $deadDir -Force -ErrorAction SilentlyContinue).Count
        Remove-Item -Recurse -Force $deadDir
        if ($held -gt 0) { Write-Host "  $cam : removed $dead\ ($held item(s) - cameras run vanilla)" }
    }
    $irisCfg = Join-Path $mcDir 'config\iris.properties'
    if (Test-Path $irisCfg) { Remove-Item -Force $irisCfg }

    $cfgFile = Join-Path $instDir 'instance.cfg'
    if (-not (Test-Path $cfgFile)) {
        $cfg = "[General]`nConfigVersion=1.2`nInstanceType=OneSix`niconKey=default`nname=$cam`n"
        [IO.File]::WriteAllText($cfgFile, $cfg, $utf8NoBom)
    }

    # ---- Window size: PINNED to the delivery format, re-asserted every run ---------------------
    # WHY. The capture resolution IS the window's client size — OBS Window Capture grabs exactly that.
    # Left unpinned it was whatever the window happened to be: measured 958x1000 on one run and
    # 2560x1370 on the next. That is two defects at once. (1) Delivery: neither is 16:9, so every take
    # needs cropping or pillarboxing for YouTube. (2) Framing: hold.frameExitDeg is specified in DEGREES
    # off the frozen aim, but how many degrees the frame spans horizontally depends on the window's
    # ASPECT — so the SAME setting meant "86% of the way to the edge" in the near-square window and
    # ~57% in the wide one. A framing constant cannot mean two things.
    # 1920x1080 is the YouTube target and the CLIENT area, so the window is slightly larger with its
    # border — it fits the 2560x1440 display, which is where the cameras are meant to be stacked
    # anyway (WGC keeps an occluded window rendering, so they need not be tiled across monitors).
    # RE-ASSERTED every run, never create-only: instance.cfg above is written only when absent, so a
    # create-only pin would leave every EXISTING camera unpinned while looking applied — the exact
    # failure mode the inactivityFpsLimit fix below was written to avoid.
    Set-InstanceCfgLine $cfgFile 'OverrideWindow'     'true'
    Set-InstanceCfgLine $cfgFile 'LaunchMaximized'    'false'
    Set-InstanceCfgLine $cfgFile 'MinecraftWinWidth'  '1920'
    Set-InstanceCfgLine $cfgFile 'MinecraftWinHeight' '1080'

    # ---- JavaPath: RE-ANCHORED to this repo whenever it has gone stale -------------------------
    # WHY THIS KEY NEEDS AN OWNER. Prism writes an ABSOLUTE JavaPath when it first auto-detects its
    # bundled runtime, and then nothing ever rewrites it. Move the repo and every camera keeps
    # pointing at the old location: the 2026-08-02 move to C:\Auren left all three instances aimed at
    # the previous tree, and no amount of re-running this script repaired it, because this script did
    # not own the key (Invariant D — state with no owner rots unattended).
    #
    # RE-ANCHOR, NEVER CHOOSE. Which runtime to use (java-runtime-delta vs gamma vs ...) is Prism's
    # decision and stays Prism's (Law 26 — never author what the machine decides). This preserves
    # whatever folder Prism picked and only re-roots it under THIS machine's $prismDir.
    #
    # THE WRONG TURN, NAMED: the first version of this gated on `-not (Test-Path $javaVal)` — "only
    # repair a path that no longer resolves" — and it was a no-op on the exact machine it was written
    # for. An abandoned tree does not reliably stop answering. Measured 2026-08-02: the previous
    # location still returned True for javaw.exe (a cloud-backed folder leaves ONLINE-ONLY PLACEHOLDER
    # reparse points behind, and an existence check succeeds on every one of them), so the stale path
    # looked healthy and the guard never fired. Existence is not evidence of the right file.
    # So the test is WHERE it points, never whether it opens — the only question with a stable answer.
    # Anything outside this repo's launcher is stale by definition, resolvable or not.
    $javaLine = Get-Content $cfgFile | Where-Object { $_ -match '^JavaPath=' } | Select-Object -First 1
    if ($javaLine) {
        $javaVal   = $javaLine -replace '^JavaPath=', ''
        $prismNorm = ($prismDir -replace '\\', '/').TrimEnd('/')
        $valNorm   = $javaVal  -replace '\\', '/'
        if ($valNorm -and -not $valNorm.StartsWith($prismNorm, [StringComparison]::OrdinalIgnoreCase)) {
            if ($javaVal -match '[\\/]java[\\/].*$') {
                $tail       = $Matches[0].TrimStart('\', '/')
                $reanchored = "$prismNorm/$tail"
                if (Test-Path -LiteralPath $reanchored) {
                    Set-InstanceCfgLine $cfgFile 'JavaPath' $reanchored
                    Write-Host "  $cam : JavaPath re-anchored -> $reanchored"
                } else {
                    Write-Host "  $cam : JavaPath stale and no runtime at $reanchored - leaving for Prism to re-detect"
                }
            }
        }
    }

    # pauseOnLostFocus is the load-bearing line: without it the game opens the pause menu the
    # moment you click away, and a background camera window records a frozen menu screen.
    $optFile = Join-Path $mcDir 'options.txt'
    if (-not (Test-Path $optFile)) {
        # ---- THE HOST SEAT INHERITS THE REAL GAME'S SETTINGS, ONCE, AT CREATION -------------------
        # A camera is a lens and its controls are never touched, so bare defaults are correct for one.
        # A presenter PLAYS in his window for an hour at a time: his keybinds, sensitivity, FOV and GUI
        # scale are the difference between filming an episode and fighting the controls through one.
        # So the host instance is seeded from the main game's own options.txt.
        #
        # ON CREATION ONLY, and never re-asserted - which is the opposite of every other key this
        # script owns, and deliberately so. The keys below are asserted every run because the FOOTAGE
        # depends on them and nothing else owns them. These are the presenter's own preferences: he
        # will change them from inside the game, Minecraft rewrites the file on exit, and a launcher
        # that copied them back every run would silently undo his settings on the next launch. Copied
        # once means the seat starts out feeling like his game and then becomes its own.
        $seeded = $false
        if ($cam -eq $HostCam) {
            $mainOpts = Join-Path $mainMc 'options.txt'
            if (Test-Path $mainOpts) {
                Copy-Item $mainOpts $optFile -Force
                $seeded = $true
                Write-Host "  $cam : settings seeded from your main game (keybinds, sensitivity, FOV)"
            }
        }
        if (-not $seeded) {
            $opts = @(
                'pauseOnLostFocus:false',
                'skipMultiplayerWarning:true',
                'joinedFirstServer:true',
                'onboardAccessibility:false',
                'tutorialStep:none'
            ) -join "`n"
            [IO.File]::WriteAllText($optFile, $opts + "`n", $utf8NoBom)
        }
    }
    # The multiplayer nag and the tutorial overlay are asserted for the host on EVERY run rather than
    # only at creation, because a seeded options.txt carries whatever the main game held and a warning
    # screen standing in front of the server list is a window that never joins - which reads downstream
    # as "the host client never arrived" rather than as a dialog nobody clicked.
    if ($cam -eq $HostCam) {
        Set-OptionLine $optFile 'skipMultiplayerWarning' 'true'
        Set-OptionLine $optFile 'joinedFirstServer'      'true'
        Set-OptionLine $optFile 'onboardAccessibility'   'false'
        Set-OptionLine $optFile 'tutorialStep'           'none'
    }

    # ---- The unfocused-framerate keys: RE-ASSERTED EVERY RUN, not written once -----------------
    # These are set unconditionally (not inside the "if not exists" above) because they are the fix
    # for a bug that EXISTING instances already have. A create-only write would leave every camera
    # built before this change stuttering forever, and the fix would look applied while doing
    # nothing for the instances that actually needed it.
    #
    # THE BUG (diagnosed 2026-07-20). Minecraft 1.21.2+ ships InactivityFpsLimiter: with no keyboard
    # or mouse input for 60s it drops the client to 30 FPS, and to 10 FPS after 10 minutes. An
    # UNFOCUSED window receives no input by definition, so every camera window except the one being
    # clicked is treated as AFK and throttled. This is NOT the same mechanism as pauseOnLostFocus
    # (which only governs the pause menu) — that one was already fixed here, and fixing it is what
    # made this second, quieter throttle the remaining cause.
    #
    # WHY IT MATTERS MORE THAN IT SOUNDS: OBS records what the window RENDERS. A throttled window
    # yields 30- or 10-FPS footage no matter what OBS's output is set to, so this is a footage-
    # quality defect, not a comfort one — and it already applied at two cameras.
    #
    # inactivityFpsLimit:minimized keeps the limiter ONLY for genuinely iconified windows, which a
    # camera never is (never minimize one — that trips the real limiter and OBS captures nothing).
    # THE WRONG TURN, NAMED: the Sodium Extra mod was proposed as the fix and does not carry this
    # option at all — it has no focus-aware setting and never has. No mod is needed; this is vanilla.
    Set-OptionLine $optFile 'inactivityFpsLimit' 'minimized'
    Set-OptionLine $optFile 'pauseOnLostFocus'   'false'
    # ---- fullscreen OFF: the window size pinned in instance.cfg only holds if the game is WINDOWED --
    # Prism's OverrideWindow/MinecraftWinWidth/Height (above) set the geometry of a WINDOW. A client
    # whose own options.txt carries `fullscreen:true` ignores all three and opens at the display's
    # fullscreenResolution instead — so the pin looks applied in instance.cfg while OBS captures a
    # 2560x1440 surface that is not the delivery format, and every framing constant expressed in
    # degrees spans a different fraction of the frame than it was measured for.
    # THE HOST SEAT IS HOW THIS ARRIVES. A bare camera instance is created with the five keys written
    # below and never held `fullscreen` at all; the host's options.txt is SEEDED FROM THE MAIN GAME
    # (see the seeding block above), and a real player's game is normally fullscreen. So the one
    # window whose framing matters most is the one window that inherits the setting that defeats it.
    # Asserted for every camera rather than only the host, on the same rule the music block states: a
    # key this launcher does not name is a key nothing owns, and options.txt is rewritten on every exit.
    Set-OptionLine $optFile 'fullscreen'         'false'
    # ---- maxFps 60: the delivery framerate, and the reason the GPU has headroom at all --------------
    # Every frame above the recording framerate is rendered and then thrown away before it reaches a
    # file, and the waste MULTIPLIES BY WINDOW COUNT - which is the direction this system scales.
    # Measured 2026-08-16 with this pinned at 260 ("Unlimited" to Minecraft): four windows held the GPU
    # at 98% for five straight minutes, flat, with no spikes - saturation by request, not by load.
    # 60 matches the OBS canvas, so nothing that survives to disk is lost.
    # NOT THE SAME KNOB AS VSYNC, which stays off: vsync blocks on the display's refresh through DWM and
    # N windows doing that serialise and cap each other. This is the game's own internal limiter and
    # costs no such synchronisation.
    Set-OptionLine $optFile 'maxFps'             '60'
    Set-OptionLine $optFile 'enableVsync'        'false'
    # ---- Music silenced at the source, on every camera, every run ---------------------------------
    # Minecraft's soundtrack and its music discs are LICENSED MUSIC, and footage carrying them earns a
    # copyright claim on the platform this is filmed for. Silenced here rather than in the editor or in
    # OBS because those are places a step can be forgotten; a camera that cannot emit the sound cannot
    # leak it into a take. Music and records only - the world's own sounds (mobs, blocks, weather) carry
    # no such claim and are what make the footage worth watching.
    #
    # MASTER IS ASSERTED, NOT ASSUMED, and that is the whole point of it being on this line. A key this
    # block does not name is a key nothing owns: Minecraft rewrites options.txt on every exit, so any
    # value the instance ever held - set by hand, carried in from a copied config, left by an older
    # revision - survives every future run untouched, and silence is the one such value that produces a
    # take which looks perfect and is unusable. Muting the two licensed categories while the master sits
    # at zero silences everything and reports nothing (Law 25: the shortfall is real and no signal
    # carries it). The launcher owns every option the footage depends on, or it owns none of them
    # (Law 16 - one owner). Same reasoning as camera_obs re-asserting capture_audio on an input that
    # already exists.
    Set-OptionLine $optFile 'soundCategory_master' '1.0'
    Set-OptionLine $optFile 'soundCategory_music'  '0.0'
    Set-OptionLine $optFile 'soundCategory_record' '0.0'
    # The remaining categories are what "all other Minecraft sound" MEANS, so they are named too rather
    # than left to whatever the instance last held - the same rule the master line above states.
    foreach ($cat in @('weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice')) {
        Set-OptionLine $optFile "soundCategory_$cat" '1.0'
    }
    # ---- chatVisibility: THE ONE SETTING THAT SPLITS BY CAMERA ---------------------------------
    # A DIRECTED camera is a lens and nothing else, so 2 (hidden) removes join/leave and system messages
    # from the bottom-left of every frame WITHOUT the F1 keypress - F1 would also hide the bot nametags,
    # which are wanted, and it cannot be automated anyway (it is a keystroke, so it would break the
    # unattended record chain).
    #
    # THE ARCHITECT'S EYE IS NOT A LENS, IT IS A SEAT, and hidden chat took away the only input channel a
    # human flying it has. There is no other way to reach the world from inside that window: teleport to a
    # bot that has wandered out of sight, set the time, summon something, switch to creative. The cost is
    # a chat line in the corner of ONE window that is not a directed shot in the first place, and the
    # camera_rig grants that seat operator so the commands it can now type actually run.
    # 0 = shown, and shown is required: "commands only" (1) hides the RESPONSE, so a refused teleport
    # would look identical to one that worked.
    #
    # THE HOST SEAT IS THE STRONGEST CASE OF THE THREE, and it is not about diagnostics. Chat is the
    # only channel to the foreman: the desk reads the WIRE and accepts `player_chat` alone, so "foreman
    # get" has to be typed by somebody holding a player slot. Hidden chat on this seat would leave the
    # presenter unable to hire the crew the episode is about, and the desk's replies - which are the
    # thing the audience is watching him read - would not be on the tape either.
    Set-OptionLine $optFile 'chatVisibility' $(if ($cam -eq $ArchitectCam -or $cam -eq $HostCam) { '0' } else { '2' })

    # renderDistance is the GAME'S to decide, not this script's. It was pinned to 12 here, which is a
    # number this file has no basis for: the right distance depends on the machine and on how many
    # windows are up, and Minecraft already picks from what it finds. Deleted rather than set to any
    # value, because writing a number is still deciding it - and deleted every run rather than only on
    # create, so instances an earlier revision pinned are released too instead of staying at 12 while
    # the code reads as if the game owned it.
    if (Remove-OptionLine $optFile 'renderDistance') { Write-Host "  $cam : renderDistance released to the game's own default" }

    # Resource packs: copy every one from the main game and enable them (vanilla base first).
    $enabledPacks = @()
    if (Test-Path $srcResource) {
        $rpDir = Join-Path $mcDir 'resourcepacks'
        New-Item -ItemType Directory -Force $rpDir | Out-Null
        foreach ($f in Get-ChildItem $srcResource -File) {
            $dst = Join-Path $rpDir $f.Name
            if (-not (Test-Path $dst) -or (Get-Item $dst).Length -ne $f.Length) { Copy-Item $f.FullName $dst -Force }
            $enabledPacks += "file/$($f.Name)"
        }
    }
    if ($enabledPacks.Count) {
        $json = '["vanilla",' + (($enabledPacks | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']'
        Set-OptionLine $optFile 'resourcePacks' $json
    }

    Write-Host "Instance ready: $cam (vanilla + resource packs)"
}

# ---- Step 3: the one-time ownership login ---------------------------------------------------
$accountsFile = Join-Path $prismData 'accounts.json'
$hasAccount = $false
if (Test-Path $accountsFile) {
    $acc = Get-Content $accountsFile -Raw
    if ($acc -match '"type"') { $hasAccount = $true }
}
if (-not $hasAccount) {
    Write-Host ''
    Write-Host '================ ONE-TIME STEP ================'
    Write-Host 'Prism Launcher will open now. Do this once:'
    Write-Host '  1. If a setup wizard appears, click through it (defaults are fine -'
    Write-Host '     let it download Java automatically if asked).'
    Write-Host '  2. Top-right: Accounts -> Manage Accounts -> Add Microsoft.'
    Write-Host '  3. Log in with the account that owns Minecraft.'
    Write-Host '  4. Close Prism and run .\start_cameras.ps1 again.'
    Write-Host '==============================================='
    Start-Process $prismExe
    exit 0
}

if ($SetupOnly) { Write-Host 'Setup complete - run without -SetupOnly to film.'; exit 0 }

# ---- Step 4: lights, cameras ----------------------------------------------------------------
# Warn (but do not block) if the game server is not up yet - clients will sit on the
# multiplayer screen until it is.
$serverUp = $false
$probe = New-Object System.Net.Sockets.TcpClient
try { $probe.Connect('127.0.0.1', 25565); $serverUp = $true } catch {} finally { $probe.Close() }
if (-not $serverUp) {
    Write-Host 'NOTE: no Minecraft server on 127.0.0.1:25565 yet - start the world first if the'
    Write-Host 'camera windows sit at the connect screen.'
}

# Prism's console output (Qt noise, auth flow, access errors) is redirected to log files that
# camera_rig.js reads, dedupes, and EXPLAINS into its watcher trace — launcher problems get
# diagnosed in watcher_camera_rig.json like everything else, not dumped raw into this window.
# NOTE: Prism is single-instance — launch #2 forwards to process #1 and exits, so most of
# Cam_TessaBot's launch output lands in Cam_AurenBot's log file. Attribution is approximate.
$launchLogDir = Join-Path $toolsDir 'camera_launch_logs'
New-Item -ItemType Directory -Force $launchLogDir | Out-Null

# Which clients are ALREADY standing, sensed from the running processes rather than remembered. Only
# -Add consults it; a plain call is opening a run and launches the whole set as it always did. The
# same forward/backslash rule the -Down teardown documents applies: Prism writes the instance path
# into the java command line with forward slashes even on Windows, so no separator may be assumed.
$alreadyUp = @()
if ($Add) {
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name LIKE 'java%'" -ErrorAction SilentlyContinue)) {
        foreach ($cam in $CamList) {
            if ($proc.CommandLine -match "instances[\\/]$([regex]::Escape($cam))[\\/]") { $alreadyUp += $cam }
        }
    }
    $alreadyUp = @($alreadyUp | Sort-Object -Unique)
}
$toLaunch = @($CamList | Where-Object { $alreadyUp -notcontains $_ })
if ($Add -and $alreadyUp.Count -gt 0) {
    Write-Host "Already standing, left alone: $($alreadyUp -join ', ')"
}

for ($i = 0; $i -lt $toLaunch.Count; $i++) {
    $cam    = $toLaunch[$i]
    $player = Get-PlayerName $cam
    $what   = if ($cam -eq $HostCam) { "HOST SEAT '$cam' as player '$player' (yours to play)" } else { "camera window '$cam'" }
    Write-Host "Launching $what (launcher log: tools\camera_launch_logs\$cam.*.log)..."
    $outLog = Join-Path $launchLogDir "$cam.out.log"
    $errLog = Join-Path $launchLogDir "$cam.err.log"
    Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
    # NOTE: in this Prism build the player name is the VALUE of --offline (see --help:
    # "-o, --offline <offline>  Launch offline, with given player name"). Instance name and player
    # name are the same string for every camera and DIFFERENT for the host, which is the whole reason
    # they are two variables here rather than one used twice.
    Start-Process $prismExe -ArgumentList '--launch', $cam, '--offline', $player, '--server', '127.0.0.1:25565' `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    # First-ever launch downloads the game once; stagger so the two instances don't fight
    # over the shared download cache.
    if ($i -lt ($toLaunch.Count - 1)) { Start-Sleep -Seconds 5 }
}

# The director — reuses $node (located up-front for the roster read; guaranteed set by the early exit).
# --bots carries ONLY the roster cameras; the Architect's eye travels on --freecams, which is armed and
# never commanded. Two lists, so the exclusion cannot be undone by an edit inside the rig.
#
# ON -Add THE DIRECTOR IS REPLACED, NOT ADDED TO. It takes its roster once, at launch, and never
# re-reads it, so a director left running would never arm or cut to a camera raised after it started -
# and two directors over one crew is two owners of one lifecycle (Invariant D), each teleporting the
# same clients to different vantages. Killed first, then raised over the full set.
#
# THE HOST SEAT IS ON NEITHER LIST. --bots is the shot list, --freecams is armed to spectator; a
# presenter must be neither. Passing no name at all is what makes "the director cannot reach it"
# structural rather than a rule inside the rig that a later edit could weaken.
$rig = Join-Path $workshopDir 'camera\camera_rig.js'
if ($Add) {
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%camera_rig.js%'" -ErrorAction SilentlyContinue)) {
        if ($proc.ProcessId -eq $PID) { continue }
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
$rigArgs = "--bots=$($BotNames -join ',') --launchlogs='$launchLogDir'"
if ($ArchitectOn) { $rigArgs += " --freecams=$ArchitectCam" }
# --presentplayers, never --bots and never --freecams. The rig's ONLY act for this name is the read
# that asks whether the client has finished joining, which is the one fact nothing else in the stack
# can answer and which the overlay gates OBS on. See the PRESENT-ONLY block in camera_rig.js.
#
# THE PLAYER NAME, NOT THE CAM NAME, and this is the one seat where those differ. Every camera joins
# under its own instance name, so for them the two strings are the same and either would have worked;
# the host joins as $HostPlayer while its WINDOW is $HostCam. The rig asks the server
# `data get entity <name> Pos`, and the server knows only who is logged in — handed the window name it
# asks about an entity that cannot exist, never confirms, and never publishes a ready crew. That is
# silent: the seat is standing in the world the whole time, so the run waits out its full ceiling and
# reports a crew that never arrived, with OBS never reached and the take unrecorded.
if ($HostOn) { $rigArgs += " --presentplayers=$HostPlayer" }
if ($Framing) { $rigArgs += ' --framing=on' }
Write-Host "Starting camera director (camera_rig.js, new window) over: $($BotNames -join ', ')"
Start-Process powershell -ArgumentList '-NoExit', '-Command', "& '$node' '$rig' $rigArgs"

# ---- Step 5: unique, stable window titles (so OBS can tell the cameras apart) ----------------
# Every camera window is otherwise "Minecraft $McVersion" — identical title/class/exe, which is
# exactly what OBS uses to identify a window, so it can't distinguish them and reattaches to the
# wrong one on a restart. This background daemon renames each window to its cam name (stable across
# restarts, derived from bot identity) so ONE OBS instance can lock a Window Capture source per
# camera and reattach correctly. It exits when the cameras do (Law 8). See camera_window_titler.ps1.
# The Architect's eye is in this list: it is a window OBS must be able to address by title like any
# other, and being undirected changes nothing about how a capture finds it.
$camNames = $CamList -join ','
$titler   = Join-Path $scriptDir 'camera_window_titler.ps1'
# Replaced on -Add for the same reason the director is: the titler is handed its list once and a
# window it was never told about keeps the identical "Minecraft <ver>" title every other client has -
# which is exactly the state OBS cannot bind through. The host seat IS in this list: it is a window
# OBS must address by title like any other, and being undirected changes nothing about that.
if ($Add) {
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%camera_window_titler.ps1%'" -ErrorAction SilentlyContinue)) {
        if ($proc.ProcessId -eq $PID) { continue }
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
Write-Host "Starting window titler (unique OBS-addressable titles): $camNames"
Start-Process powershell -WindowStyle Minimized -ArgumentList '-NoProfile', '-File', $titler, '-Cams', $camNames

Write-Host ''
$eyeNote = if ($ArchitectOn) { " (incl. $ArchitectCam - yours to fly)" } else { ' (no Architect eye - add -Architect for a seat you fly)' }
$hostNote = if ($HostOn) { " (incl. $HostCam - yours to PLAY, joined as $HostPlayer)" } else { '' }
Write-Host "Camera crew up: $($CamList.Count) window(s)$eyeNote$hostNote + 1 director + titler."
Write-Host 'In each camera window: press F1 once for clean footage.'
Write-Host 'OBS (one instance for all cameras): add a Window Capture per camera, method "Windows 10'
Write-Host '(1903+)", pick the window titled Cam_<Bot>, priority "Match title". With the Source Record'
Write-Host 'plugin, give each source a Source Record filter to write its own per-bot file.'
