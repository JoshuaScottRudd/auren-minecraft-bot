# Camera window titler - gives each Prism camera window a UNIQUE, STABLE OS window title so
# OBS can tell them apart.
#
# WHY THIS EXISTS. Every Minecraft camera window carries the identical OS title ("Minecraft
# 1.21.5"), the identical window class (GLFW) and the identical executable (javaw.exe). OBS's
# Window Capture identifies a window by exactly those three fields - so with all three identical
# it cannot distinguish Cam 1 from Cam 2, grabs "a window of that type" at random, and on a
# camera restart (new OS window handle, same title) reattaches to whichever - the cameras appear
# to swap between OBS sources. Renaming each window to its own cam name (the SAME name every
# time, derived from bot identity, not launch order or screen position) makes each window
# uniquely and permanently addressable: OBS locks a source to a title and reattaches to the
# CORRECT window after any restart, with zero re-picking.
#
# WHY A DAEMON, not a one-shot. The window doesn't exist yet when start_cameras launches the
# client (java is still booting), and it can be recreated mid-session on a camera restart -
# both need the title (re-)applied. So this polls on a slow cadence and re-asserts the title
# every pass (idempotent). Setting on any pass is harmless; missing a restart is not.
#
# LIFECYCLE (Law 8 - no zombie). It waits for the cameras to appear, then exits the moment the
# last one is gone. Its life is bound to the thing it serves; nothing runs on past the cameras.
#
# Matching is by COMMAND LINE, not by process order: each camera's java process carries its
# instance name (...\instances\Cam_<Bot>\.minecraft...) on its command line, so the cam name is an
# exact, order-independent discriminator. The `Name LIKE 'java%'` clause keeps this from matching
# our own powershell process (whose args also contain the cam names).

param(
    [Parameter(Mandatory = $true)]
    [string]$Cams,                 # comma-separated cam window names, e.g. "Cam_AurenBot,Cam_TessaBot"
    [int]$PollSeconds = 3,
    [int]$FirstAppearTimeoutSeconds = 180   # give up if no camera window ever shows (launch failed)
)

$camList = @($Cams -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($camList.Count -lt 1) { Write-Host 'No cam names supplied - nothing to title.'; exit 0 }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Title {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetWindowText(IntPtr hWnd, string lpString);
}
"@

Write-Host "Camera titler watching: $($camList -join ', ')  (poll ${PollSeconds}s)"

$seenAny  = $false          # latch: true once at least one camera window has appeared
$waited   = 0               # seconds spent waiting for the FIRST window (pre-latch only)

while ($true) {
    $aliveNow = $false
    foreach ($cam in $camList) {
        # The game java process for this instance carries the instance path on its command line.
        # `Name LIKE 'java%'` excludes this titler's own powershell (whose args also hold the name).
        $procs = Get-CimInstance Win32_Process `
            -Filter "Name LIKE 'java%' AND CommandLine LIKE '%$cam%'" -ErrorAction SilentlyContinue
        foreach ($proc in $procs) {
            $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
            if ($p -and $p.MainWindowHandle -ne 0) {
                # Re-assert every pass (idempotent). Do NOT gate on the current title reading
                # "Minecraft" - after the first rename it reads the cam name, and gating there
                # would stop us re-applying it after a client-driven title reset.
                [void][Win32Title]::SetWindowText($p.MainWindowHandle, $cam)
                $aliveNow = $true
            }
        }
    }

    if ($aliveNow) {
        $seenAny = $true
    }
    elseif ($seenAny) {
        Write-Host 'All camera windows gone - titler exiting (Law 8).'
        break
    }
    else {
        $waited += $PollSeconds
        if ($waited -ge $FirstAppearTimeoutSeconds) {
            Write-Host "No camera window appeared in ${FirstAppearTimeoutSeconds}s - titler exiting."
            break
        }
    }

    Start-Sleep -Seconds $PollSeconds
}
