<#
.SYNOPSIS
    Start EchoSphere — both services, optionally a tunnel, then the pre-flight.

.DESCRIPTION
    Run this from the repository root:

        .\start.ps1                 console + Slow Loop
        .\start.ps1 -Tunnel         ... and let Echo READ THE LEDGER (see below)
        .\start.ps1 -Tunnel -Reset  ... and clear the board first

    ── WHY THIS EXISTS ────────────────────────────────────────────────────
    The README's two-terminal instructions were written with `&&`, which is a
    PARSE ERROR in Windows PowerShell 5.1 — the shell this project is actually
    developed in. `cd backend && python ...` does not run and does not explain
    itself; it just fails to parse, which looks like the project is broken.

    Shell syntax is not something anyone should have to think about ninety
    seconds before a demo. This script starts the Slow Loop and the console,
    waits until both genuinely answer, and runs the pre-flight.

.PARAMETER Tunnel
    Expose the Slow Loop through a cloudflared tunnel and point Agora's REST
    tools at it.

    ── WHAT THIS ACTUALLY BUYS ────────────────────────────────────────────
    Agora's Conversational AI Engine calls tool endpoints from ITS OWN
    servers. `http://127.0.0.1:8000` resolves to Agora's machine, not ours, so
    without a public URL the agent is created with NO TOOLS — and Echo, which
    is under a hard rule never to answer from memory, cannot answer anything
    about the incident. It hears you, it can speak, and it has nothing to say.

    With the tunnel, `query_incident_state` works: ask Echo what is happening
    and it performs an HTTP call against the same Ledger the dashboard renders
    from. That is the difference between an agent that talks and one you can
    actually hold a conversation with.

    A tunnel exposes the WHOLE Slow Loop, not one endpoint, so this also
    generates AGENT_TOOL_SECRET and writes both halves to frontend/.env.local.
    The backend refuses any non-local request that does not present it.

.PARAMETER SkipPreflight
    Start the services without running the pre-flight check.

.PARAMETER Reset
    Clear the incident board and stop any leftover agent before checking.

.PARAMETER KeepRunning
    Do NOT stop the previous session first.

    By default every run stops the Slow Loop and console this repository
    started, then boots fresh — because a service running from before a code
    change keeps serving the old modules while this script prints GO over it.

    Only processes whose command line names THIS checkout are touched. A
    service on :3000 or :8000 belonging to another project is reported and
    left alone.
#>
[CmdletBinding()]
param(
    [switch]$SkipPreflight,
    [switch]$Reset,
    [switch]$Tunnel,
    [switch]$Share,
    [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"

# Sharing the console is pointless without the backend tunnel: a remote browser
# would load the page and then fail every call to the Slow Loop.
if ($Share) { $Tunnel = $true }
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$python = Join-Path $backend ".venv\Scripts\python.exe"
$envFile = Join-Path $frontend ".env.local"

function Write-Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  OK   $text" -ForegroundColor Green }
function Write-Bad($text)  { Write-Host "  FAIL $text" -ForegroundColor Red }
function Write-Note($text) { Write-Host "       $text" -ForegroundColor DarkGray }

# ── STOPPING THE PREVIOUS SESSION ────────────────────────────────────────────
#
# Every run starts clean, because "already running on :8000" was being treated
# as success — so a service started from BEFORE a code change kept serving, and
# the script reported GO over it. That is the shape of an entire afternoon lost
# to editing files a running process had already imported.
#
# ── WHY THIS MATCHES ON THE COMMAND LINE AND NOT ON THE PORT ─────────────────
#
# The obvious implementation is `Get-NetTCPConnection -LocalPort 3000 | Stop-Process`,
# which is what several places in this script used to do. It is dangerous.
#
# Measured on this machine: port 3001 was held by
# `orchestrator\lawgic-frontend-lks-prod` — a completely unrelated project. A
# port sweep would have killed somebody's other work, and on 3000 it would kill
# whatever dev server happened to be there.
#
# So a process is only ours if its command line names THIS repository. That is
# the only reliable signal: the ports are shared, the process names are generic
# (`node.exe`, `python.exe`), and the window titles are hidden.
#
# NOTE the previous attempt at this filter was
#     $_.CommandLine -like "*$($frontend.Replace('','\'))*"
# `.Replace('', '\')` replaces the EMPTY string, which is a no-op — so the path
# guard never actually constrained anything.
# ── WHY THE PARENT CHAIN, NOT JUST THE PROCESS ─────────────────────────────
#
# A venv python RE-EXECS itself through the global interpreter, and the child
# that ends up holding the port has NO repository path in its command line:
#
#   [0] PID 23704  C:\...\Programs\Python\Python312\python.exe -m uvicorn ...
#   [1] PID 19792  C:\...\EchoSphere\backend\.venv\Scripts\python.exe -m uvicorn ...
#
# Only the PARENT names the checkout. Matching on the listener alone therefore
# reported OUR OWN backend as "not from this repo" and refused to restart it -
# which is exactly what happened on a `-Share` run: the guest origin was
# written to .env.local, the restart was skipped, and the message said
# "left :8000 alone" over a process this script had started itself.
#
# Walks up a few generations and stops at the first ancestor that names the
# checkout. Bounded so a pathological chain cannot loop, and it still refuses
# to touch a listener from a genuinely unrelated project.
function Test-ProcessIsOurs($proc) {
    $needle = $root.TrimEnd('\')
    $cur = $proc
    for ($depth = 0; $depth -lt 5 -and $cur; $depth++) {
        if ($cur.CommandLine -and $cur.CommandLine.Replace('/', '\') -like "*$needle*") { return $true }
        if (-not $cur.ParentProcessId -or $cur.ParentProcessId -le 4) { break }
        $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
    }
    return $false
}

function Stop-PreviousSession {
    param([switch]$IncludeTunnel)

    $ours = @()

    # Anything whose command line mentions this checkout. Covers the uvicorn
    # Slow Loop, `next dev`, and the cmd.exe wrapper the console is launched
    # under, without needing to know which is which.
    # `Test-ProcessIsOurs` rather than a direct command-line match: a venv
    # python re-execs through the global interpreter, so the process actually
    # holding :8000 carries no repository path and was being missed here. See
    # the note on that function.
    foreach ($name in 'python.exe', 'node.exe', 'cmd.exe') {
        $procs = Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue |
                 Where-Object {
                     $_.ProcessId -ne $PID -and (Test-ProcessIsOurs $_)
                 }
        if ($procs) { $ours += $procs }
    }

    foreach ($proc in $ours) {
        $what = if ($proc.CommandLine -match 'uvicorn') { "Slow Loop" }
                elseif ($proc.CommandLine -match 'next|npm') { "console" }
                else { "helper" }
        Write-Note "stopping previous $what (PID $($proc.ProcessId))"
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }

    # Quick tunnels are per-run: the URL changes every time and the old one is
    # already dead, so a leftover process is pure noise. Only reaped when this
    # run is about to open its own, so a `.\start.ps1` with no -Tunnel does not
    # silently close the tunnel a previous run opened.
    if ($IncludeTunnel) {
        $cfs = Get-Process cloudflared -ErrorAction SilentlyContinue
        foreach ($cf in $cfs) {
            Write-Note "stopping previous tunnel (PID $($cf.Id))"
            Stop-Process -Id $cf.Id -Force -ErrorAction SilentlyContinue
        }
    }

    if ($ours -or ($IncludeTunnel -and $cfs)) {
        # Sockets do not close the instant the process dies, and starting a
        # replacement into a still-bound port is how the console silently
        # lands on :3001.
        Start-Sleep -Milliseconds 1500
    }

    foreach ($port in 8000, 3000) {
        $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($still) {
            # Deliberately NOT killed — see the note above about port 3001.
            # Named instead, so an operator can decide.
            $pid2 = $still[0].OwningProcess
            $other = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid2" -ErrorAction SilentlyContinue).CommandLine
            Write-Note "NOTE :$port is held by a process outside this repo (PID $pid2)"
            if ($other) { Write-Note "      $($other.Substring(0, [Math]::Min(90, $other.Length)))" }
        }
    }

    if ($ours) { Write-Ok "previous session stopped ($($ours.Count) process(es))" }
    else { Write-Note "no previous session was running" }
}

# Stop only OUR process serving a given port, for the mid-script restarts that
# have to happen after an env change. Same repository guard as
# `Stop-PreviousSession`: killing by port alone is what would take down an
# unrelated project that happens to hold :3000.
function Stop-OurServiceOnPort($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { return $false }

    foreach ($c in $conn) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        if ($proc -and (Test-ProcessIsOurs $proc)) {
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 1200
            return $true
        }
    }
    Write-Note "left :$port alone - the listener is not from this repo"
    return $false
}

# ── FINDING CLOUDFLARED, ONCE ────────────────────────────────────────────────
#
# winget installs it and reports success, but a shell that was ALREADY OPEN
# captured its PATH at launch, so `cloudflared` is "not recognized" in the very
# window that just installed it. That reads as a broken installer rather than a
# stale environment, and it has now cost two rounds of confusion.
#
# So: never rely on PATH. Look where winget actually writes.
function Resolve-Cloudflared {
    $found = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\cloudflared.exe"),
        (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "cloudflared\cloudflared.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

# The hostname pattern, and the one host it must NEVER match.
#
# ── api.trycloudflare.com IS NOT A TUNNEL ───────────────────────────────────
#
# `https://[a-z0-9-]+\.trycloudflare\.com` looks like it matches only a quick
# tunnel hostname. It also matches Cloudflare's own API endpoint, which
# cloudflared prints when the request for a tunnel FAILS:
#
#     failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel":
#     context deadline exceeded (Client.Timeout exceeded while awaiting headers)
#
# So the scan found a URL in the failure message, and every caller treated a
# match as success. Measured on this machine: a timed-out tunnel produced
# `https://api.trycloudflare.com`, which was reported as "tunnel live" and
# written into .env.local as AGENT_TOOL_BASE_URL and NEXT_PUBLIC_SLOW_LOOP_WS.
#
# Nothing downstream can recover from that. Agora POSTs its tool calls to a
# host that is not us, guests open a WebSocket to it and hang, and the console
# reports the Slow Loop as unreachable - so the visible symptom is "the tunnel
# is not working" everywhere EXCEPT the line that announced it working.
#
# A wrong URL announced as correct is strictly worse than no tunnel: without
# one the script exits 1 and says so.
$script:TunnelHostPattern = "https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com"
$script:TunnelApiHost     = "api.trycloudflare.com"

# cloudflared's own words for "this did not work". Checked so a failure is
# reported as a failure in the second it happens, rather than after the full
# 45-second wait with nothing to explain it.
$script:TunnelFailPattern = "failed to request quick Tunnel|context deadline exceeded|ERR .*Cannot determine default origin"

# ── THE ONES WORTH TRYING AGAIN, AND WHY THIS IS NOT JUST OPTIMISM ─────────
#
# Measured on this connection, five consecutive POSTs to the quick-tunnel API
# (the request cloudflared makes to get a hostname):
#
#     17.4s   5.4s   5.8s   5.5s   6.2s      all HTTP 200
#
# cloudflared gives that request roughly 15 seconds, so the normal ~6s case
# succeeds and an occasional slow one blows the deadline and reports
#
#     failed to request quick Tunnel: ... context deadline exceeded
#
# Nothing is misconfigured when that happens - port 7844 is open both over
# IPv4 and IPv6, DNS resolves, and the very next attempt usually works. It is
# a slow link straddling somebody else's timeout.
#
# One attempt therefore makes a coin-flip out of `-Tunnel`, and the cost of
# losing is the whole run: the script exits 1 before either service starts.
# A timeout is retried instead.
#
# NOT everything is retried. A missing origin or a bad flag fails identically
# every time, so retrying it just multiplies the wait before the same message.
$script:TunnelRetryPattern = "context deadline exceeded|Client\.Timeout|i/o timeout|connection reset|EOF"

# ── PROBING A TUNNEL FROM *THIS* MACHINE IS NOT A FAIR TEST ────────────────
#
# Measured on this network:
#
#     nslookup hiv-lie-per-iron.trycloudflare.com            -> timeout
#     nslookup hiv-lie-per-iron.trycloudflare.com 1.1.1.1    -> 104.16.230.132
#     curl --resolve ...:443:104.16.230.132 .../health        -> HTTP 200
#
# The local resolver (20.20.20.114, a corporate DNS) does not answer for
# *.trycloudflare.com at all, while the tunnel itself is perfectly alive and
# reachable. So a plain Invoke-RestMethod against the hostname fails HERE for
# everyone whose DNS filters it - and that failure says nothing whatsoever
# about whether Agora or a guest can reach it, because they resolve elsewhere.
#
# Treating that as "the tunnel is dead" caused two real, visible faults in one
# run: a LIVE backend tunnel was declared dead and AGENT_TOOL_BASE_URL was
# wiped (so Echo lost its ability to read the Ledger), and the guest
# verification reported the 404 bug over a share tunnel that was serving 200.
#
# This resolves through a PUBLIC resolver and, when the local one cannot
# answer, retries the request with the address pinned - the same thing
# `curl --resolve` does. A tunnel is only reported dead when it genuinely
# fails to answer at an address we know is real.
#
# Returns: "live" | "dead" | "unresolvable" (with $script:LastProbeBody set
# on "live"). "unresolvable" means WE cannot check, not that it is broken -
# and the caller must not clear credentials on it.
#
# ── AND WHY IT RETRIES ──────────────────────────────────────────────────────
#
# A quick tunnel is not serving the instant `cloudflared` prints its hostname.
# Cloudflare has to propagate the edge route, which took several seconds on
# this connection - so the FIRST probe after creation failed against a tunnel
# that answered perfectly moments later.
#
# Observed in one run: the script created
# `jones-pasta-buildings-judy.trycloudflare.com`, probed it immediately,
# declared "the configured tunnel no longer answers" and wiped
# AGENT_TOOL_BASE_URL - and the very same URL returned HTTP 200 when checked
# by hand a minute afterwards. Echo lost the Ledger for the whole run because
# of a race, not a fault.
#
# Clearing credentials is destructive and hard to attribute later, so it now
# takes several failures over ~15s rather than one.
function Test-TunnelHealth($baseUrl) {
    $attempts = 5
    for ($i = 1; $i -le $attempts; $i++) {
        $verdict = Test-TunnelHealthOnce $baseUrl
        # A definite answer either way needs no retry. Only "dead" is worth
        # doubting, because a warming-up edge looks exactly like a dead one.
        if ($verdict -ne "dead") { return $verdict }
        if ($i -lt $attempts) { Start-Sleep -Seconds 3 }
    }
    return "dead"
}

function Test-TunnelHealthOnce($baseUrl) {
    $script:LastProbeBody = $null
    $uri      = [Uri]$baseUrl
    # NOT $host - that is a PowerShell automatic variable (the host UI object)
    # and assigning to it fails with "Cannot overwrite variable Host".
    $tunnelHost = $uri.Host

    # 1. The straightforward attempt. Works on a normal network.
    try {
        $script:LastProbeBody = Invoke-RestMethod "$baseUrl/health" -TimeoutSec 20
        return "live"
    } catch {
        # Anything other than a name-resolution failure is a real answer about
        # the tunnel: a 502, a refused connection, a timeout on a resolved
        # address. Only DNS failure is ambiguous, so only DNS failure falls
        # through to the pinned attempt below.
        if ($_.Exception.Message -notmatch "remote name could not be resolved|No such host is known|actively refused") {
            return "dead"
        }
    }

    # 2. Resolve through a public resolver the local one cannot override.
    $addr = $null
    foreach ($resolver in "1.1.1.1", "8.8.8.8") {
        try {
            $answer = Resolve-DnsName -Name $tunnelHost -Server $resolver -Type A `
                      -DnsOnly -ErrorAction Stop | Where-Object { $_.IPAddress }
            if ($answer) { $addr = $answer[0].IPAddress; break }
        } catch { }
    }
    if (-not $addr) { return "unresolvable" }

    # 3. Ask the address directly, carrying the Host header and SNI so
    #    Cloudflare still routes it to the right tunnel. `-Headers Host` alone
    #    is not enough - the TLS handshake needs the name too, which is why
    #    this connects by hostname but with the address pinned in the hosts
    #    resolution order via a per-request override.
    try {
        # PowerShell 5.1 has no --resolve equivalent, so the check is made over
        # HTTP-on-IP with an explicit Host header. The tunnel answers /health
        # identically on both, and this only has to prove liveness.
        $script:LastProbeBody = Invoke-RestMethod "https://$addr/health" `
            -Headers @{ Host = $tunnelHost } -TimeoutSec 20
        return "live"
    } catch {
        # A certificate complaint proves a TLS endpoint IS there and answering
        # for that address - which is all this needs to establish. The
        # hostname mismatch is expected when connecting by IP.
        if ($_.Exception.Message -match "trust|certificate|SSL|secure channel") {
            return "unresolvable"
        }
        return "dead"
    }
}

# Pull a real tunnel hostname out of whatever cloudflared has written so far.
# Returns $null when the only match is the API endpoint.
function Find-TunnelUrl($paths) {
    foreach ($path in $paths) {
        if (-not $path -or -not (Test-Path $path)) { continue }
        # ALL matches, not the first: the API host and the real hostname can
        # both be present, and -First would take whichever came earlier.
        $found = Select-String -Path $path -Pattern $script:TunnelHostPattern `
                 -AllMatches -ErrorAction SilentlyContinue
        foreach ($line in $found) {
            foreach ($match in $line.Matches) {
                if ($match.Value -notlike "*$script:TunnelApiHost*") { return $match.Value }
            }
        }
    }
    return $null
}

# Did cloudflared say outright that it failed?
function Test-TunnelFailed($paths) {
    foreach ($path in $paths) {
        if (-not $path -or -not (Test-Path $path)) { continue }
        $hit = Select-String -Path $path -Pattern $script:TunnelFailPattern `
               -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.Line.Trim() }
    }
    return $null
}

# Open a quick tunnel and return its public URL, or $null.
#
# ── WHERE THE URL ACTUALLY APPEARS ─────────────────────────────────────────
#
# This used to pass `--logfile` and grep only that file. Verified against
# cloudflared 2026.8.3 on this machine, all three destinations at once:
#
#     stdout    0 bytes          <- nothing, ever
#     stderr    the banner       <- the hostname is here
#     --logfile the banner       <- and here
#
# stdout being EMPTY is the part that matters, because the Slow Loop tunnel
# below watches stdout and a comment there claims the banner is printed to it.
# Whichever single stream a caller picked, it could be the wrong one - and the
# streams have moved between cloudflared versions, which is why this now
# writes to all three and searches all three rather than betting on one.
#
# Each run gets its OWN files. A reused log means reading the PREVIOUS run's
# hostname and announcing a dead URL as live - the same class of failure as
# the API-host match above, by a slower route.
# ONE attempt. Returns a hostname string on success, or $null - and sets
# $script:LastTunnelError to cloudflared's own words so the caller can decide
# whether trying again is worth anything.
function Start-QuickTunnelOnce($exe, $target, $tag) {
    $script:LastTunnelError = $null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $log = Join-Path $env:TEMP "echosphere-$tag-$stamp.log"
    $out = "$log.out"
    $err = "$log.err"

    # `-PassThru` so a failed attempt can be cleaned up by PID. Killing every
    # cloudflared instead would take down the Slow Loop tunnel that `-Share`
    # has ALREADY opened and still depends on.
    $proc = Start-Process -FilePath $exe `
        -ArgumentList "tunnel", "--url", $target, "--no-autoupdate", "--logfile", $log `
        -RedirectStandardOutput $out `
        -RedirectStandardError $err `
        -WindowStyle Hidden `
        -PassThru
    $script:LastTunnelPid = $proc.Id

    $paths = @($log, $out, $err)
    foreach ($i in 1..45) {
        Start-Sleep -Milliseconds 1000

        $url = Find-TunnelUrl $paths
        if ($url) { return $url }

        # Fail fast and say why. Waiting the remaining 40 seconds to print
        # "did not come up" hides a reason cloudflared already gave us.
        $failure = Test-TunnelFailed $paths
        if ($failure) {
            $script:LastTunnelError = $failure
            return $null
        }
    }
    $script:LastTunnelError = "no tunnel hostname after 45s (log: $err)"
    return $null
}

# Open a quick tunnel, retrying the failures that are worth retrying.
#
# The retry budget is small on purpose. Three attempts covers the measured
# timeout rate (roughly one slow POST in five) without turning a genuinely
# broken environment into a two-minute wait before the same error - and each
# attempt already carries its own 45-second ceiling.
function Start-QuickTunnel($exe, $target, $tag) {
    $attempts = 3
    foreach ($attempt in 1..$attempts) {
        $url = Start-QuickTunnelOnce $exe $target $tag
        if ($url) {
            if ($attempt -gt 1) { Write-Note "tunnel came up on attempt $attempt" }
            return $url
        }

        $why = $script:LastTunnelError
        if ($why) { Write-Note "cloudflared: $why" }

        # Whether we stop here or try again, the process that just failed must
        # not be left running: a cloudflared that never produced a hostname is
        # useless, and one still holding a half-open connection makes the NEXT
        # run's diagnosis harder.
        $failedPid = $script:LastTunnelPid

        if ($attempt -eq $attempts) {
            if ($failedPid) { Stop-Process -Id $failedPid -Force -ErrorAction SilentlyContinue }
            break
        }

        # Only transient faults get another go.
        if ($why -notmatch $script:TunnelRetryPattern) {
            Write-Note "not a timeout - retrying would fail the same way"
            if ($failedPid) { Stop-Process -Id $failedPid -Force -ErrorAction SilentlyContinue }
            break
        }

        # Stop THIS attempt's process only, by PID. A blanket
        # `Get-Process cloudflared | Stop-Process` would also kill the Slow
        # Loop tunnel opened earlier in the run, so `-Share` would retry its
        # console tunnel and silently take the backend's tunnel down with it.
        if ($script:LastTunnelPid) {
            Stop-Process -Id $script:LastTunnelPid -Force -ErrorAction SilentlyContinue
        }
        Write-Note "that was a timeout, not a misconfiguration - retrying ($($attempt + 1)/$attempts)"
        Start-Sleep -Seconds 3
    }
    return $null
}

# KEEP STRING LITERALS IN THIS FILE PURE ASCII.
#
# PowerShell 5.1 reads a .ps1 without a BOM as ANSI. An em-dash then decodes
# to CP1252 0x94, which IS a right curly quote - and PowerShell accepts curly
# quotes as string delimiters, so the literal ends early and the parse
# cascades into "missing closing }" errors dozens of lines away.
#
# Comments are safe (they run to end of line), which is why the box-drawing
# above is fine and one em-dash inside a Write-Note broke the whole script.

Write-Host ""
Write-Host "  EchoSphere" -ForegroundColor White
Write-Host ""

# ── prerequisites ───────────────────────────────────────────────────────────
if (-not (Test-Path $python)) {
    Write-Bad "no virtualenv at backend\.venv"
    Write-Host ""
    Write-Host "  Create it once:" -ForegroundColor Yellow
    Write-Host "    cd backend"
    Write-Host "    python -m venv .venv"
    Write-Host "    .\.venv\Scripts\pip install -r requirements.txt"
    Write-Host ""
    exit 1
}
if (-not (Test-Path (Join-Path $frontend "node_modules"))) {
    Write-Bad "frontend dependencies are not installed"
    Write-Host ""
    Write-Host "  Install them once:" -ForegroundColor Yellow
    Write-Host "    cd frontend"
    Write-Host "    npm install"
    Write-Host ""
    exit 1
}

# ── stop whatever the last run left behind ──────────────────────────────────
#
# Before the tunnel, before any credential is written, before either service
# boots. A process started prior to a code change has already imported the old
# modules, and it will keep serving them while this script cheerfully prints
# GO — which is indistinguishable from the change not working.
#
# `-KeepRunning` opts out for the rare case of attaching to a session that is
# deliberately already up.
if (-not $KeepRunning) {
    Write-Step "stopping the previous session ..."
    Stop-PreviousSession -IncludeTunnel:$Tunnel
} else {
    Write-Note "-KeepRunning: leaving any existing services alone"
}

# ─────────────────────────────────────────────────────────────────────────────
# Write a key into frontend/.env.local without disturbing anything else.
#
# This file holds real secrets. Only the named key is touched, the rest of the
# file is passed through byte for byte, and nothing is ever echoed to the
# console — the project rule is that credential VALUES are never displayed,
# only their presence.
# ─────────────────────────────────────────────────────────────────────────────
function Set-EnvKey($key, $value) {
    $lines = if (Test-Path $envFile) { @(Get-Content $envFile) } else { @() }
    $out = New-Object System.Collections.Generic.List[string]
    $found = $false
    foreach ($line in $lines) {
        if ($line -match "^\s*$([regex]::Escape($key))\s*=") {
            $out.Add("$key=$value"); $found = $true
        } else { $out.Add($line) }
    }
    if (-not $found) { $out.Add("$key=$value") }

    # ── RETRIED, BECAUSE next dev WATCHES THIS FILE ────────────────────────
    #
    # The console's dev server reads .env.local and keeps a watcher on it, and
    # Windows takes a real exclusive lock while it does. A write landing in
    # that window dies with
    #
    #     Set-Content : The process cannot access the file '...\.env.local'
    #     because it is being used by another process.
    #
    # which, under $ErrorActionPreference = "Stop", ABORTS THE WHOLE SCRIPT -
    # observed mid-run right after the console started, leaving .env.local
    # half-updated and the run dead on its feet.
    #
    # The lock is momentary, so a few short retries clear it. The final
    # attempt is deliberately left un-caught: if the file is genuinely
    # unwritable that must still be loud.
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Set-Content -Path $envFile -Value $out -Encoding UTF8 -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq 5) { throw }
            Start-Sleep -Milliseconds 400
        }
    }
}

function Get-EnvKey($key) {
    if (-not (Test-Path $envFile)) { return $null }
    foreach ($line in Get-Content $envFile) {
        if ($line -match "^\s*$([regex]::Escape($key))\s*=\s*(.+)$") { return $Matches[1].Trim() }
    }
    return $null
}

# ── the tunnel, before anything reads its environment ───────────────────────
#
# Both services load frontend/.env.local at startup, so the URL and the secret
# have to be on disk BEFORE they boot. If either is already running with a
# stale value it is restarted below — a Next.js dev server does not re-read
# .env.local, and a backend that missed the secret refuses every tool call
# with a 401 that looks exactly like Echo declining to answer.
$tunnelUrl = $null
if ($Tunnel) {
    # ── FIND IT, DO NOT JUST ASK PATH ───────────────────────────────────────
    #
    # winget installs cloudflared and reports success, but the PATH entry it
    # adds is not visible to a shell that was already open - the environment
    # was captured at launch. So the very next command in the same window says
    # "cloudflared is not installed" immediately after a successful install,
    # which reads as a broken installer rather than a stale PATH.
    #
    # Checking the two locations winget actually writes to costs nothing and
    # removes the "restart your terminal" step entirely.
    $cfPath = Resolve-Cloudflared
    if (-not $cfPath) {
        Write-Bad "cloudflared is not installed"
        Write-Note "winget install --id Cloudflare.cloudflared"
        Write-Note "if you JUST installed it, open a new terminal - PATH is stale here"
        Write-Note "or run without -Tunnel; Echo will talk but cannot read the Ledger."
        exit 1
    }
    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
        Write-Note "found cloudflared at $cfPath (not on PATH in this shell)"
    }
    $cf = [PSCustomObject]@{ Source = $cfPath }

    Write-Step "opening a tunnel to the Slow Loop ..."

    # STOP THE OLD TUNNEL FIRST. Two reasons, and the second is the dangerous
    # one:
    #
    #   1. Windows will not delete a file another process holds open, and with
    #      $ErrorActionPreference = "Stop" that failure aborted the whole
    #      script. Reported live: "Cannot remove item ... because it is being
    #      used by another process".
    #
    #   2. Worse, and silent if the delete is merely skipped: the URL scan
    #      below takes the FIRST match in the log. A log left over from the
    #      previous run still contains the previous URL, so the script would
    #      announce "tunnel live" and write a DEAD hostname into .env.local -
    #      configuring broken tools while reporting success.
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    # Tidy up previous runs, best-effort. `Start-QuickTunnel` timestamps its
    # own files, so a log we cannot delete is harmless and this must never be
    # fatal.
    #
    # The filter is `echosphere-*` and not `echosphere-cloudflared*.log`,
    # which missed two things: the `-console` logs that `-Share` writes, and
    # the `.out`/`.err` files alongside every log - so the directory grew a
    # pair of orphans per run forever.
    Get-ChildItem -Path $env:TEMP -Filter "echosphere-*" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "^echosphere-(cloudflared|console)-" } |
        ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { } }

    # ── ONE IMPLEMENTATION, NOT TWO ────────────────────────────────────────
    #
    # This block had its own copy of "start cloudflared and scan for the URL",
    # and `-Share` had another in `Start-QuickTunnel`. They disagreed about
    # the one thing that matters - which stream to read - so a fix applied to
    # the copy in front of you left the other one broken. The console tunnel
    # was still passing `--logfile` alone months after this block stopped.
    #
    # Both now call the same helper, which writes all three destinations and
    # searches all three. The measurements behind that live above it.
    #
    # An earlier comment here asserted the hostname is "printed to STDOUT".
    # It is not, on cloudflared 2026.8.3: stdout is EMPTY and the banner goes
    # to stderr and --logfile. The claim was wrong in a way that happened to
    # work, because this block searched stderr too.
    $tunnelUrl = Start-QuickTunnel $cf.Source "http://localhost:8000" "cloudflared"

    if (-not $tunnelUrl) {
        Write-Bad "the tunnel did not come up"
        Write-Note "run without -Tunnel to start anyway; Echo will talk but cannot read the Ledger."
        exit 1
    }
    Write-Ok "tunnel live  $tunnelUrl"

    # A fresh secret per tunnel. The URL changes every run anyway, so there is
    # nothing to be gained by reusing the old one and something to lose.
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [System.BitConverter]::ToString($bytes).Replace("-", "").ToLower()

    Set-EnvKey "AGENT_TOOL_BASE_URL" $tunnelUrl
    Set-EnvKey "AGENT_TOOL_SECRET" $secret

    # ── THE BROWSER DOES *NOT* GET A SEPARATE URL ANY MORE ──────────────────
    #
    # AGENT_TOOL_BASE_URL above is for AGORA's servers calling our tools, and
    # it still needs a public hostname. The BROWSER used to need its own
    # (NEXT_PUBLIC_SLOW_LOOP_WS, pointing at this same backend tunnel) and
    # that is what is being removed here.
    #
    # Why: `next.config.ts` now REWRITES the Slow Loop's paths - /observer/*,
    # /ws/deltas, /agent/*, /bridge/*, /tools/*, /health and the rest - from
    # the console's own origin to 127.0.0.1:8000. A browser can therefore
    # reach the Slow Loop at the same origin it loaded the page from, whether
    # that is localhost or a tunnel, and `delta-socket.ts`'s same-origin
    # fallback is now CORRECT rather than merely assumed.
    #
    # What that fixes, reported live:
    #
    #     TRANSCRIPT FORWARDING PAUSED: SLOW LOOP RETURNED HTTP 404
    #
    # with an empty transcript, an empty Ledger and no graph. The variable had
    # been CLEARED by the stale-tunnel branch below, so the browser fell back
    # to its own origin - the console on :3000 - which had no
    # /observer/transcript and answered every forwarded turn with Next's 404
    # page. The delta socket went the same way, which is why nothing rendered.
    #
    # Measured before the rewrite:
    #     next.js :3000 /observer/transcript -> 404
    #     python  :8000 /observer/transcript -> 200
    # and after it, both 200.
    #
    # Cleared rather than left alone: a value written by an EARLIER run points
    # at a tunnel that is now dead, and a dead absolute URL beats the working
    # same-origin default. Empty is the good state now.
    Set-EnvKey "NEXT_PUBLIC_SLOW_LOOP_WS" ""

    Write-Ok "tool credentials written to frontend\.env.local"
    Write-Note "browsers reach the Slow Loop through the console's own origin"

    # Anything still holding the old environment has to go. Normally
    # `Stop-PreviousSession` above already cleared it; this covers the
    # -KeepRunning case, where a service the operator chose to keep is now
    # holding a tunnel URL that no longer exists.
    if ($KeepRunning) {
        Write-Note "the tunnel URL changed - restarting services to pick it up"
        Stop-PreviousSession
    }
}

# ── Slow Loop ───────────────────────────────────────────────────────────────
# No "already running" branch. `Stop-PreviousSession` ran above, so a listener
# on :8000 now belongs to something outside this repo — and starting anyway is
# the honest move: uvicorn will fail loudly on the bound port rather than this
# script reporting OK over somebody else's service.
$slowLoop = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($slowLoop -and $KeepRunning) {
    Write-Ok "Slow Loop already running on :8000 (-KeepRunning)"
} else {
    Write-Step "starting the Slow Loop on :8000 ..."
    Start-Process -FilePath $python `
        -ArgumentList "-m", "uvicorn", "app.main:app", "--port", "8000" `
        -WorkingDirectory $backend -WindowStyle Hidden

    $up = $false
    foreach ($i in 1..40) {
        Start-Sleep -Milliseconds 800
        try {
            Invoke-RestMethod "http://127.0.0.1:8000/health" -TimeoutSec 4 | Out-Null
            $up = $true; break
        } catch { }
    }
    if ($up) { Write-Ok "Slow Loop is up" }
    else {
        Write-Bad "the Slow Loop did not start"
        Write-Host "  Run it in the foreground to see why:" -ForegroundColor Yellow
        Write-Host "    cd backend"
        Write-Host "    .\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"
        exit 1
    }
}

# ── console ─────────────────────────────────────────────────────────────────
# ── WHY A SINGLE CONSOLE ON A KNOWN PORT MATTERS ────────────────────────────
#
# Next 16 does NOT fail when :3000 is taken by another `next dev` — it takes
# the next free port and says so only in a window this script hides. The probe
# below then polls :3000 forever, reports "the console did not start", and
# exits 1 while the console is up and serving on :3001.
#
# Observed exactly that: PID 23112 on :3001, script exit 1, app fine.
#
# Worse than the wasted minute: the invite path mints tokens against an origin
# the browser is not on, so CORS silently drops the transcript POSTs and Echo
# goes deaf in the one way this project keeps rediscovering.
#
# The stale-server sweep that used to live here has moved into
# `Stop-PreviousSession`, which runs before the tunnel rather than after it —
# and which actually works. The filter here was
#     $_.CommandLine -like "*$($frontend.Replace('','\'))*"
# and `.Replace('', '\')` replaces the EMPTY string: a no-op, so the path guard
# matched every `next dev` on the machine regardless of repository.
# ── AND WHY A FOREIGN LISTENER ON :3000 HAS TO BE FATAL ─────────────────────
#
# `Stop-PreviousSession` deliberately leaves a listener that is not ours
# alone, and that is right - it protects other projects. But then this block
# started `next dev --port 3000` into the occupied port anyway.
#
# Windows does not refuse that. The squatter holds IPv4 127.0.0.1:3000 and
# Next binds the still-free IPv6 `::`:3000, so BOTH serve on "port 3000" and
# which one a client reaches depends on how it resolves `localhost`.
#
# Measured on this machine: an unrelated `ms-365-mcp-server` held IPv4 :3000,
# the console came up on IPv6 :3000, and probes split -
#     http://127.0.0.1:3000/health -> 404   (the squatter)
#     http://[::1]:3000/health     -> 200   (the console)
# The old probe below used `http://localhost:3000` and got a 200 from the
# WRONG SERVER, so this script printed "console is up" over someone else's
# app. A tunnel then published that app instead of the console.
#
# There is no safe automatic move here: killing it takes down another
# project, and continuing publishes the wrong thing. So it is named and the
# run stops, which is the one outcome that cannot mislead.
# ── MOVE ASIDE RATHER THAN DEMAND THE PORT BACK ────────────────────────────
#
# The first version of this guard exited 1 and told the operator to kill the
# offending PID. That is unusable against the squatter actually on this
# machine: `ms-365-mcp-server` is supervised and RESTARTS within seconds, so
# it came back under a new PID every time and the instruction could never
# be satisfied.
#
# Taking the next free port is the honest move - the port number was never
# load-bearing, and everything that needs to know is told below.
function Test-PortFree($port) {
    -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# ── THE CONSOLE DOES NOT USE :3000 AT ALL ──────────────────────────────────
#
# 3000 is the default port of every Node dev server on the machine, which
# makes it the single most contended port here and the one this script kept
# losing. Sharing it is not merely untidy, it is BROKEN in a way that is
# hard to see: Windows lets a squatter hold IPv4 127.0.0.1:3000 while Next
# binds the still-free IPv6 `::`:3000, so BOTH answer on "port 3000" and
# which one a client reaches depends on how it resolves `localhost`.
#
# Measured here: an unrelated `ms-365-mcp-server` on IPv4 :3000, the console
# on IPv6 :3000, and probes split -
#     http://127.0.0.1:3000/health -> 404   (the squatter)
#     http://[::1]:3000/health     -> 200   (the console)
# The readiness probe used `http://localhost:3000`, took a 200 from the WRONG
# SERVER and reported the console up. A `-Share` tunnel then publishes
# somebody else's app to the people you sent the link to.
#
# That squatter is also SUPERVISED: it restarted within seconds under a new
# PID every time, so "stop PID n and re-run" was an instruction that could
# never be satisfied. Avoiding the port outright is the only stable fix.
#
# 3100 is the base. ECHO_CONSOLE_PORT overrides it, and `demo.mjs` already
# reads that same variable.
$consolePort = 0
$preferred = if ($env:ECHO_CONSOLE_PORT) { [int]$env:ECHO_CONSOLE_PORT } else { 3100 }

foreach ($candidate in @($preferred) + @(3100, 3200, 3300, 3400, 3500)) {
    if ($candidate -eq 3000) { continue }   # never 3000, even if asked
    if (Test-PortFree $candidate) { $consolePort = $candidate; break }
    # Ours from a previous run that -KeepRunning wants to reuse.
    if ($KeepRunning) {
        $held = Get-NetTCPConnection -LocalPort $candidate -State Listen -ErrorAction SilentlyContinue
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($held[0].OwningProcess)" -ErrorAction SilentlyContinue
        if ($p -and $p.CommandLine -and $p.CommandLine.Replace('/', '\') -like "*$($root.TrimEnd('\'))*") {
            $consolePort = $candidate; break
        }
    }
}

if ($consolePort -eq 0) {
    Write-Bad "no free console port (tried $preferred, 3100, 3200, 3300, 3400, 3500)"
    Write-Note "free one, or pass your own:  `$env:ECHO_CONSOLE_PORT = 3600; .\start.ps1"
    exit 1
}

# Everything downstream reads this rather than assuming 3000: the readiness
# probe, the tunnel target, `npm run demo`, and the closing instructions.
$env:ECHO_CONSOLE_PORT = "$consolePort"
$consoleOrigin = "http://127.0.0.1:$consolePort"

$console = Get-NetTCPConnection -LocalPort $consolePort -State Listen -ErrorAction SilentlyContinue
if ($console -and $KeepRunning) {
    Write-Ok "console already running on :$consolePort (-KeepRunning)"
} else {
    Write-Step "starting the console on :$consolePort ..."
    # `--port 3000` so a busy port is an ERROR we can see rather than a silent
    # move to 3001. Logged to a file because the window is hidden and a
    # failure with no output is the thing that wasted the most time here.
    $clog = Join-Path $env:TEMP ("echosphere-console-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
    Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "npm run dev -- --port $consolePort > `"$clog`" 2>&1" `
        -WorkingDirectory $frontend -WindowStyle Hidden

    # ── PROBE 127.0.0.1, NOT `localhost`, AND PROBE THE PROXY ──────────────
    #
    # `localhost` can resolve to ::1 or 127.0.0.1, so on a machine where
    # something else holds one of the two families this probe could answer
    # from the wrong server entirely (see the note above). An explicit IPv4
    # literal removes the ambiguity.
    #
    # And the page rendering is no longer sufficient evidence. The console now
    # has to PROXY the Slow Loop for the browser to reach it at all, so
    # `/health` through :3000 is the thing worth asserting - it is exactly the
    # path the 404 bug broke, and a config that fails to load looks perfectly
    # healthy on `/`.
    $up = $false
    $proxied = $false
    foreach ($i in 1..60) {
        Start-Sleep -Milliseconds 900
        try {
            $r = Invoke-WebRequest $consoleOrigin -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { $up = $true }
        } catch { }
        if ($up) {
            try {
                $h = Invoke-WebRequest "$consoleOrigin/health" -UseBasicParsing -TimeoutSec 5
                if ($h.StatusCode -eq 200) { $proxied = $true }
            } catch { }
            break
        }
    }
    if ($up -and $proxied) { Write-Ok "console is up, and proxies the Slow Loop" }
    elseif ($up) {
        # Serving, but the rewrites are not answering. The browser would get a
        # 404 on every transcript POST - the exact reported failure - so this
        # is loud rather than a warning nobody reads.
        Write-Bad "the console is up but does NOT proxy the Slow Loop (/health -> not 200)"
        Write-Note "frontend/next.config.ts must define rewrites() for /observer/*, /ws/deltas and /health."
        Write-Note "Without them the browser POSTs transcripts to the console and gets HTTP 404:"
        Write-Note "    TRANSCRIPT FORWARDING PAUSED: SLOW LOOP RETURNED HTTP 404"
        exit 1
    }
    else {
        Write-Bad "the console did not start"
        if (Test-Path $clog) {
            Write-Note "last lines of $clog"
            Get-Content $clog -Tail 15 | ForEach-Object { Write-Note "  $_" }
        }
        Write-Host "  Run it in the foreground to see why:" -ForegroundColor Yellow
        Write-Host "    cd frontend"
        Write-Host "    npm run dev"
        exit 1
    }
}

# ── can Agora actually reach us? ────────────────────────────────────────────
#
# Checked from OUTSIDE, through the tunnel, because that is the path Agora
# takes. A tunnel process that started is not the same as a tunnel that
# routes, and the difference only shows up as Echo silently having no tools.
#
# ── AND CHECKED EVERY RUN, NOT ONLY WHEN -Tunnel OPENED ONE ────────────────
# This used to test `$tunnelUrl`, which is set only when THIS invocation
# opened a tunnel. Two things went wrong with that:
#
#   1. Running plain `.\start.ps1` with a tunnel already live printed "Echo
#      cannot read the Ledger" and told you to restart with -Tunnel. It could
#      read the Ledger perfectly well. Reported live.
#
#   2. Worse and silent: cloudflared exits, .env.local keeps the dead URL, and
#      the next invite creates an agent WITH tools pointed at a host that no
#      longer resolves. Every tool call then fails — and a tool that always
#      fails is worse than an absent one, because the model retries, collects
#      errors, and falls back on its own memory. That is the exact
#      hallucination this product exists to prevent, arriving through the
#      component meant to prevent it.
#
# So: the configured URL is the source of truth, and it is probed. A URL that
# does not answer is CLEARED rather than left to poison the next invite.
$configuredTunnel = Get-EnvKey "AGENT_TOOL_BASE_URL"
$tunnelLive = $false

if ($configuredTunnel) {
    # DNS-aware: on this network the local resolver does not answer for
    # *.trycloudflare.com at all, so a plain request fails against a tunnel
    # that is perfectly alive. See the long note on `Test-TunnelHealth`.
    $health = Test-TunnelHealth $configuredTunnel

    if ($health -eq "unresolvable") {
        # WE cannot check it; that is not evidence it is broken. Agora and any
        # guest resolve through their own DNS and are unaffected, so the
        # credentials MUST be kept - clearing them here is what silently cost
        # Echo its ability to read the Ledger on a working tunnel.
        $tunnelLive = $true
        Write-Ok "tunnel credentials kept  $configuredTunnel"
        Write-Note "this machine's DNS cannot resolve *.trycloudflare.com, so it"
        Write-Note "cannot be verified from here. Agora resolves it independently."
        Write-Note "verify by hand if you want certainty:"
        Write-Note "  Resolve-DnsName $(([Uri]$configuredTunnel).Host) -Server 1.1.1.1"
    }
    elseif ($health -eq "live") {
        $probe = $script:LastProbeBody

        # ── "IT ANSWERED" IS NOT "IT IS OURS" ──────────────────────────────
        # A response only proves SOMETHING is at that hostname. When a bad URL
        # got written here - `https://api.trycloudflare.com`, Cloudflare's own
        # API endpoint, which the URL scan used to match out of cloudflared's
        # failure message - this probe reached a live host that is not us. It
        # returned a plain string, so `$probe.ready` was empty, and that took
        # the "routes but not ready" branch: a URL pointing at Cloudflare was
        # reported as OUR tunnel having a slow start, and the clearing code in
        # the catch below never ran. So the dead URL survived in .env.local and
        # poisoned every later run, which is why this presented as "the tunnel
        # is not working" long after the tunnel itself.
        #
        # The Slow Loop's /health returns a JSON OBJECT. Anything that is not
        # one is somebody else's endpoint, and it is treated as a dead tunnel
        # so it gets CLEARED rather than kept.
        $notOurs = ($probe -is [string]) -or ($null -eq $probe.PSObject.Properties['ready'])

        if ($notOurs) {
            $health = "dead"
            Write-Note "that hostname answered, but it is not the Slow Loop"
        }
        elseif ($probe.ready) {
            $tunnelLive = $true
            Write-Ok "Agora can reach the Ledger through the tunnel"
        }
        else {
            Write-Bad "the tunnel routes, but the Slow Loop is not ready"
        }
    }

    # Only a tunnel we PROVED dead is cleared. "unresolvable" keeps its
    # credentials above, and that distinction is the whole point of the
    # helper: a wiped AGENT_TOOL_BASE_URL costs Echo the Ledger, and doing it
    # on the strength of a local DNS failure was a self-inflicted outage.
    if ($health -eq "dead") {
        Write-Bad "the configured tunnel no longer answers"
        Write-Note $configuredTunnel
        Write-Note "clearing it - stale tool URLs are worse than none at all"
        Set-EnvKey "AGENT_TOOL_BASE_URL" ""
        Set-EnvKey "AGENT_TOOL_SECRET" ""
        # Cleared with them, and now genuinely harmless: the console proxies
        # the Slow Loop's paths at its own origin (`next.config.ts` rewrites),
        # so an empty value means "same origin" and the bridge keeps working.
        #
        # It did NOT used to mean that. Clearing this dropped the browser onto
        # an origin with no /observer/transcript, which answered 404 - the
        # "TRANSCRIPT FORWARDING PAUSED" this branch was quietly causing every
        # time a tunnel went stale.
        Set-EnvKey "NEXT_PUBLIC_SLOW_LOOP_WS" ""
        Write-Note "re-run with -Tunnel to open a fresh one"
        # The console cached the dead value at boot; without this it keeps
        # handing it to Agora until someone restarts it by hand.
        if (Stop-OurServiceOnPort $consolePort) {
            # `--port` explicitly: a bare `npm run dev` would take Next's
            # default 3000, which this script deliberately never uses, and the
            # probe below would then wait out its full 54 seconds on the port
            # the console is NOT on.
            Start-Process -FilePath "cmd.exe" `
                -ArgumentList "/c", "npm run dev -- --port $consolePort" `
                -WorkingDirectory $frontend -WindowStyle Hidden
            foreach ($i in 1..60) {
                Start-Sleep -Milliseconds 900
                try {
                    $r = Invoke-WebRequest $consoleOrigin -UseBasicParsing -TimeoutSec 5
                    if ($r.StatusCode -eq 200) { break }
                } catch { }
            }
            Write-Note "console restarted without the dead tunnel"
        }
    }
}

Write-Host ""

# ── pre-flight ──────────────────────────────────────────────────────────────
Push-Location $frontend
try {
    if ($Reset) { & npm run demo reset --silent }
    if (-not $SkipPreflight) { & npm run demo --silent }
} finally {
    Pop-Location
}

# ── SHARING THE CONSOLE ──────────────────────────────────────────────────────
#
# The -Tunnel flag exposes the SLOW LOOP so Agora's servers can call our REST
# tools. That does nothing for a human on another machine: they need the web
# app itself. This opens a second quick tunnel for :3000 and hands you a URL to
# send them.
#
# ── WHY CORS_ORIGINS HAS TO BE WRITTEN HERE ─────────────────────────────────
# A remote browser's page origin is the tunnel hostname, not localhost. Every
# transcript that browser captures is POSTed to /observer/transcript, and the
# Slow Loop's CORS list only contains localhost:3000/3001 by default. Without
# the origin added, the browser silently drops those POSTs and the guest can
# talk all they like while the Ledger stays empty - the exact class of silent
# failure this project has spent days removing. So the origin is written to
# .env.local and the Slow Loop is restarted to read it.
#
# ⚠️ A trycloudflare URL is PUBLIC and unauthenticated. Anyone with the link
# gets your console. Fine for a demo; do not leave it running.
$shareUrl = $null
if ($Share) {
    Write-Host ""
    Write-Step "opening a tunnel to the console ..."

    $shareUrl = Start-QuickTunnel $cf.Source "http://127.0.0.1:$consolePort" "console"
    if (-not $shareUrl) {
        Write-Bad "the console tunnel did not come up"
        Write-Note "the local console on :$consolePort is unaffected"
    } else {
        Write-Ok "console tunnel live  $shareUrl"

        # Let the guest's browser reach the Slow Loop, then restart it so the
        # new origin is actually loaded.
        #
        # ── ONLY THIS RUN'S ORIGIN, NOT EVERY RUN'S ────────────────────────
        # This used to append the new share URL to whatever was already there
        # and never remove anything. A quick tunnel gets a new random hostname
        # every run, so the list grew by one dead origin per `-Share` - found
        # at TWENTY-EIGHT entries on this machine, twenty-seven of which point
        # at tunnels that no longer exist.
        #
        # Nothing is gained by keeping them: an origin is only useful while its
        # tunnel is up, and a stale one cannot be distinguished from a live one
        # without probing all of them. Keeping the list to the origins that can
        # actually be serving right now also keeps the allow-list honest - this
        # is the header that decides whose browser may POST to the Ledger.
        $origins = $shareUrl
        Set-EnvKey "CORS_ORIGINS" $origins

        Stop-OurServiceOnPort 8000 | Out-Null
        Start-Process -FilePath $python `
            -ArgumentList "-m", "uvicorn", "app.main:app", "--port", "8000" `
            -WorkingDirectory $backend -WindowStyle Hidden

        # ── AND CHECK THAT IT CAME BACK ────────────────────────────────────
        # The wait loop `break`s on success and simply falls through on
        # failure, so "guests may now reach the Ledger" was printed
        # unconditionally - including when the restart never bound.
        #
        # That is not hypothetical. A uvicorn started outside this repo (from
        # a global Python, so `Stop-OurServiceOnPort` correctly refuses to
        # kill it) holds :8000; the venv copy launched here then exits
        # immediately on the port conflict, and the script reported success
        # over a backend that was not running. The guest gets a console that
        # loads and a Ledger that never answers.
        $backendUp = $false
        foreach ($i in 1..40) {
            Start-Sleep -Milliseconds 800
            try {
                Invoke-RestMethod "http://127.0.0.1:8000/health" -TimeoutSec 4 | Out-Null
                $backendUp = $true
                break
            } catch { }
        }

        if ($backendUp) {
            Write-Ok "guests may now reach the Ledger"

            # ── PROVE THE GUEST PATH, NOT JUST THE LOCAL ONE ───────────────
            #
            # Everything above this point can pass while the thing a guest
            # actually does still fails. The reported bug lived exactly here:
            # the console loaded perfectly over the tunnel and then every
            # transcript POST came back 404, because that origin had no
            # /observer/* route.
            #
            # So the real request is made through the real tunnel. `/health`
            # is proxied by the console to the Slow Loop, so a 200 proves the
            # whole chain a guest depends on - tunnel to console, console
            # rewrite to :8000 - in one call. Anything else and the demo is
            # already broken; better to know now than from a guest.
            # DNS-aware, for the same reason as the backend tunnel above: this
            # machine's resolver does not answer for *.trycloudflare.com, and
            # the first version of this check reported the 404 bug over a
            # share tunnel that was serving HTTP 200 to everybody else.
            # Confirmed by hand at the time:
            #     nslookup <host>          -> timeout
            #     nslookup <host> 1.1.1.1  -> 104.16.230.132
            #     curl --resolve ...       -> HTTP 200
            $guest = Test-TunnelHealth $shareUrl

            if ($guest -eq "live") {
                Write-Ok "verified: guests reach the Slow Loop through the console"
            }
            elseif ($guest -eq "unresolvable") {
                Write-Note "cannot verify the share link from this machine - its DNS does"
                Write-Note "not resolve *.trycloudflare.com. Guests resolve independently,"
                Write-Note "and the local console proxies correctly, so this is expected here."
            }
            else {
                Write-Bad "the shared console did not answer /health through the tunnel"
                Write-Note "guests would see: TRANSCRIPT FORWARDING PAUSED: SLOW LOOP RETURNED HTTP 404"
            }
        } else {
            Write-Bad "the Slow Loop did not come back after adding the guest origin"
            Write-Note "something outside this repo is probably holding :8000 - check with:"
            Write-Note "  Get-NetTCPConnection -LocalPort 8000 -State Listen"
            Write-Note "guests can load the console, but the Ledger will not answer them"
        }
    }
}

Write-Host "  Next:" -ForegroundColor White
Write-Host "    open " -NoNewline
Write-Host $consoleOrigin -ForegroundColor Cyan -NoNewline
Write-Host " and press J"
if ($consolePort -ne 3100) {
    # Said out loud because it is not the number in the README, and a person
    # who opens :3100 out of habit gets whatever else is on it.
    Write-Note "(the console is on :$consolePort this run)"
}
if ($tunnelLive) {
    Write-Host "    Echo will greet you out loud, then answer questions about the incident."
    Write-Host "    Feed it the incident first, then ask:"
    Write-Host "                           cd frontend"
    Write-Host "                           npm run demo feed"
    Write-Host "    then say out loud:  " -NoNewline
    Write-Host '"Echo, what do we know so far?"' -ForegroundColor Cyan
    Write-Host "    and push it:        " -NoNewline
    Write-Host '"Echo, is Redis the cause?"' -ForegroundColor Cyan
    Write-Host "                        it will refuse, and that refusal is the point."
    Write-Host ""
    Write-Host "    Watching the Ledger while you talk:  " -NoNewline
    Write-Host "npm run demo speech" -ForegroundColor Cyan
} else {
    Write-Host "    Echo will greet you out loud, but cannot read the Ledger."
    Write-Host "    For a real conversation, restart with:  " -NoNewline
    Write-Host ".\start.ps1 -Tunnel" -ForegroundColor Cyan
    Write-Host "    then, in this window:  cd frontend"
    Write-Host "                           npm run demo feed"
}
Write-Host ""

if ($shareUrl) {
    Write-Host "  Share with others:" -ForegroundColor White
    Write-Host "    $shareUrl" -ForegroundColor Cyan
    Write-Host "    Same channel as you - the backend keeps ONE ledger and ONE agent." -ForegroundColor DarkGray
    Write-Host "    Public and unauthenticated; stop this script when you are done." -ForegroundColor DarkGray
    Write-Host ""
}
