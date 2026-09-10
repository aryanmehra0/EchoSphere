<#
.SYNOPSIS
    Stop EchoSphere - every service this repository started, and optionally
    every trace of the incident it recorded.

.DESCRIPTION
    Run this from the repository root:

        .\stop.ps1              stop the services, keep the data
        .\stop.ps1 -Clean       ... and delete the incident data
        .\stop.ps1 -Clean -All  ... and the Postgres volume and build caches

    ── WHY THE ORDER IN THIS FILE MATTERS ─────────────────────────────────
    The Agora Cloud Agent is NOT a process on this machine. It runs on
    Agora's infrastructure and keeps running - and billing - after every
    window here is closed. The only way to stop it is to ask, over HTTP,
    through a Slow Loop that is still alive.

    So this script stops things in the one order that works:

        1. the Cloud Agent      (needs the backend UP)
        2. the incident board   (needs the backend UP)
        3. the tunnels
        4. the console and the Slow Loop
        5. the data on disk     (needs the backend DOWN - SQLite locks)

    Killing the services first, which is the obvious implementation, leaves
    a live agent in the channel with nothing able to reach it. It sits there
    until Agora's idle timeout - and under `remote_rtc_uids: ["*"]` a stray
    agent counts as a participant, so that timeout may never fire.

.PARAMETER Clean
    Delete the incident data: the SQLite event store, the Postgres rows, and
    the tunnel credentials in frontend/.env.local.

    Deliberately NOT the default. Stopping and wiping are different
    intentions, and the destructive one should be typed.

.PARAMETER All
    With -Clean, also remove the Postgres DOCKER VOLUME and the build caches
    (.next, __pycache__). The next start re-creates the schema from
    backend/db/schema.sql and rebuilds, so the first run afterwards is slow.

.PARAMETER KeepTunnels
    Leave cloudflared running. Only useful if you are restarting the services
    behind a tunnel whose URL you want to keep - which no longer helps much,
    since a quick tunnel's hostname changes on every run anyway.

.PARAMETER Force
    Skip the confirmation prompt for -Clean.
#>
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$All,
    [switch]$KeepTunnels,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# -All only means anything alongside -Clean. Silently ignoring it would let
# someone type `.\stop.ps1 -All` expecting a wipe and get none.
if ($All -and -not $Clean) {
    Write-Host ""
    Write-Host "  -All only applies with -Clean. Did you mean:  .\stop.ps1 -Clean -All" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

$root     = $PSScriptRoot
$backend  = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$envFile  = Join-Path $frontend ".env.local"
$channel  = "inc-4417"

function Write-Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  OK   $text" -ForegroundColor Green }
function Write-Bad($text)  { Write-Host "  FAIL $text" -ForegroundColor Red }
function Write-Note($text) { Write-Host "       $text" -ForegroundColor DarkGray }

# KEEP STRING LITERALS IN THIS FILE PURE ASCII - see the same note in
# start.ps1. PowerShell 5.1 reads a BOM-less .ps1 as ANSI, an em-dash decodes
# to a curly quote, and PowerShell accepts curly quotes as string delimiters:
# the literal ends early and the parse cascades into errors dozens of lines
# away. Comments are safe; string bodies are not.

Write-Host ""
Write-Host "  EchoSphere - stopping" -ForegroundColor White
Write-Host ""

# ── 1. THE CLOUD AGENT, WHILE THE BACKEND CAN STILL BE ASKED ────────────────
#
# `/api/stop-agent` is the console's route and it is the one the app itself
# uses, so it releases the roster row and stops the agent the same way a
# person pressing Q would. Falling back to the Slow Loop's own /agent/stop
# covers the case where the console is already gone but uvicorn is not.
$backendAlive = $false
try {
    Invoke-RestMethod "http://127.0.0.1:8000/health" -TimeoutSec 4 | Out-Null
    $backendAlive = $true
} catch { }

if ($backendAlive) {
    Write-Step "stopping the Agora Cloud Agent ..."
    $agentStopped = $false

    try {
        $r = Invoke-RestMethod "http://127.0.0.1:3000/api/stop-agent" -Method Post `
             -ContentType "application/json" -Body (@{ channel = $channel } | ConvertTo-Json) `
             -TimeoutSec 20
        $agentStopped = $true
        if ($r.stopped) { Write-Ok "agent stopped at Agora" }
        else { Write-Note "no agent was running" }
    } catch {
        # The console may already be down; ask the Slow Loop directly.
        try {
            Invoke-RestMethod "http://127.0.0.1:8000/agent/stop" -Method Post `
                -ContentType "application/json" -Body (@{ channel = $channel } | ConvertTo-Json) `
                -TimeoutSec 20 | Out-Null
            $agentStopped = $true
            Write-Ok "agent stopped through the Slow Loop"
        } catch {
            Write-Bad "could not stop the Cloud Agent"
            Write-Note $_.Exception.Message
        }
    }

    if (-not $agentStopped) {
        # Loud, because this one costs money and cannot be fixed later from
        # this machine once the services are gone.
        Write-Note "an agent may still be RUNNING and BILLING at Agora."
        Write-Note "Check and stop it from the Agora console, or start the app"
        Write-Note "again and run:  cd frontend; npm run demo reset"
    }

    if ($Clean) {
        # Only with -Clean: clearing the board is data loss, and a plain stop
        # must be able to be followed by a start that resumes the incident.
        Write-Step "clearing the incident board ..."
        try {
            Invoke-RestMethod "http://127.0.0.1:8000/incident/reset" -Method Post -TimeoutSec 15 | Out-Null
            Write-Ok "board cleared"
        } catch {
            Write-Note "could not clear the board over HTTP - the files are removed below anyway"
        }
    }
} else {
    Write-Note "the Slow Loop is not running - skipping the agent stop"
    Write-Note "if an agent was left running, it is still live at Agora."
}

# ── 2. TUNNELS ──────────────────────────────────────────────────────────────
#
# Every cloudflared on the machine, not just ours: a quick tunnel carries no
# marker tying it to this repository, and `start.ps1` reaps them the same
# blanket way. A tunnel is also a PUBLIC, UNAUTHENTICATED hole into this
# console, so leaving one open by accident is the worse mistake.
if (-not $KeepTunnels) {
    $cfs = @(Get-Process cloudflared -ErrorAction SilentlyContinue)
    if ($cfs.Count -gt 0) {
        Write-Step "closing $($cfs.Count) tunnel(s) ..."
        foreach ($cf in $cfs) {
            Stop-Process -Id $cf.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Ok "tunnels closed"
    } else {
        Write-Note "no tunnel was running"
    }
} else {
    Write-Note "leaving tunnels running (-KeepTunnels)"
}

# ── 3. THE SERVICES ─────────────────────────────────────────────────────────
#
# ── MATCHED ON THE COMMAND LINE, NEVER ON THE PORT ─────────────────────────
# The same rule as `Stop-PreviousSession` in start.ps1, for the same measured
# reason: on this machine an unrelated project (`ms-365-mcp-server`) holds
# 127.0.0.1:3000, and another checkout held :3001. A port sweep would kill
# somebody else's work.
#
# A process is ours only if its command line names THIS checkout. The ports
# are shared and the process names are generic (node.exe, python.exe), so the
# path is the only reliable signal.
Write-Step "stopping the console and the Slow Loop ..."

# ── AND WHY THE PARENT CHAIN, NOT JUST THE PROCESS ─────────────────────────
#
# A venv python RE-EXECS itself through the global interpreter, so the process
# that ends up holding :8000 has NO repository path in its command line:
#
#   [0] PID 23704  C:\...\Programs\Python\Python312\python.exe -m uvicorn ...
#   [1] PID 19792  C:\...\EchoSphere\backend\.venv\Scripts\python.exe -m uvicorn ...
#
# Only the PARENT names the checkout. Matching the listener alone leaves our
# own Slow Loop running and reports it as somebody else's - so the "stopped"
# app keeps serving, and a later start reports GO over stale modules.
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

$ours = @()
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
    Write-Note "stopping $what (PID $($proc.ProcessId))"
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

if ($ours.Count -gt 0) {
    Write-Ok "stopped $($ours.Count) process(es)"
    # Sockets do not close the instant a process dies, and SQLite does not
    # release its lock any faster. The clean step below needs both.
    Start-Sleep -Milliseconds 1500
} else {
    Write-Note "nothing from this repository was running"
}

# Anything still on our ports belongs to someone else. Named, never killed.
foreach ($port in 8000, 3000) {
    $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($still) {
        $pid2  = $still[0].OwningProcess
        $other = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid2" -ErrorAction SilentlyContinue).CommandLine
        Write-Note "NOTE :$port is still held by a process outside this repo (PID $pid2)"
        if ($other) { Write-Note "      $($other.Substring(0, [Math]::Min(90, $other.Length)))" }
    }
}

# ── 4. THE DATA ─────────────────────────────────────────────────────────────
if (-not $Clean) {
    Write-Host ""
    Write-Ok "EchoSphere is stopped"
    Write-Note "the incident data is intact - the next start resumes it"
    Write-Note "to wipe it:  .\stop.ps1 -Clean"
    Write-Host ""
    exit 0
}

if (-not $Force) {
    Write-Host ""
    Write-Host "  -Clean will DELETE:" -ForegroundColor Yellow
    Write-Host "    - backend/data/incident_events.db  (claims, entities, timeline)"
    Write-Host "    - the Postgres rows in the echosphere database"
    Write-Host "    - the tunnel credentials in frontend/.env.local"
    if ($All) {
        Write-Host "    - the Postgres docker VOLUME (echosphere-pgdata)" -ForegroundColor Yellow
        Write-Host "    - build caches (.next, __pycache__)" -ForegroundColor Yellow
    }
    Write-Host ""
    # Read-Host is safe here: this script is run interactively by a person.
    # -Force is the path for anything automated.
    $answer = Read-Host "  Type 'yes' to continue"
    if ($answer -ne 'yes') {
        Write-Host ""
        Write-Note "nothing was deleted - the services are stopped"
        Write-Host ""
        exit 0
    }
}

Write-Host ""
Write-Step "removing the incident data ..."

# ── SQLite: the .db AND its journal siblings ────────────────────────────────
#
# The event store runs in WAL mode, so committed data lives in
# `incident_events.db-wal` until a checkpoint folds it back. Deleting only the
# .db leaves the WAL and SHM behind, and SQLite will happily replay them into
# the fresh database - so the "cleaned" board comes back populated.
#
# Measured here: the .db was 4 KB while the -wal held 935 KB. Almost the whole
# incident was in the file the obvious implementation does not delete.
$dataDir = Join-Path $backend "data"
if (Test-Path $dataDir) {
    $dbFiles = @(Get-ChildItem -Path $dataDir -File -ErrorAction SilentlyContinue |
                 Where-Object { $_.Name -like "*.db" -or $_.Name -like "*.db-wal" -or $_.Name -like "*.db-shm" })
    foreach ($f in $dbFiles) {
        try {
            Remove-Item $f.FullName -Force -ErrorAction Stop
            Write-Note "removed $($f.Name)"
        } catch {
            # Almost always a service that has not fully exited yet.
            Write-Bad "could not remove $($f.Name) - still locked"
            Write-Note "a service may still be shutting down; run this again in a moment"
        }
    }
    if ($dbFiles.Count -eq 0) { Write-Note "no SQLite data to remove" }
    else { Write-Ok "SQLite event store cleared" }
} else {
    Write-Note "no backend/data directory"
}

# ── Postgres ────────────────────────────────────────────────────────────────
#
# Two very different operations behind one flag, and the difference is the
# schema. TRUNCATE keeps the tables that `docker-entrypoint-initdb.d` created
# on first boot; removing the volume destroys them and lets the next `up`
# re-run schema.sql. The volume only re-initialises when it is ABSENT, so
# `-All` is the only way to genuinely start from the schema file again.
$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
    $running = $false
    try {
        $ps = & docker ps --filter "name=echosphere-postgres" --format "{{.Names}}" 2>$null
        $running = [bool]$ps
    } catch { }

    if ($All) {
        Write-Step "removing the Postgres volume ..."
        try {
            & docker compose -f (Join-Path $root "docker-compose.yml") down -v 2>&1 | Out-Null
            Write-Ok "Postgres container and volume removed"
            Write-Note "the next start re-creates the schema from backend/db/schema.sql"
        } catch {
            Write-Bad "could not remove the Postgres volume"
            Write-Note $_.Exception.Message
        }
    } elseif ($running) {
        Write-Step "clearing the Postgres rows ..."
        # TRUNCATE every table the app owns, in one statement so foreign keys
        # cannot order-fail. CASCADE covers anything referencing them.
        $sql = "TRUNCATE claims, entities, links, tasks, timeline, unchecked, contradictions, transcripts RESTART IDENTITY CASCADE;"
        try {
            $out = & docker exec echosphere-postgres psql -U echo -d echosphere -c $sql 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "Postgres rows cleared"
            } else {
                # A table named here may not exist in every schema version.
                # Not fatal: the SQLite store above is the one the dashboard
                # rehydrates from.
                Write-Note "psql reported: $out"
                Write-Note "some tables may not exist in this schema - continuing"
            }
        } catch {
            Write-Note "could not reach psql in the container - skipping"
        }
    } else {
        Write-Note "the Postgres container is not running - nothing to clear"
    }
} else {
    Write-Note "docker not found - skipping Postgres"
}

# ── Tunnel credentials ──────────────────────────────────────────────────────
#
# These are per-run and every one of them is dead the moment the tunnel
# closes. Leaving them is actively harmful rather than merely untidy: Agora
# POSTs its tool calls to AGENT_TOOL_BASE_URL, and a stale hostname sends the
# incident's tool traffic to whoever holds that name next.
#
# The API keys and the Agora certificate are NOT touched - they are the
# operator's real credentials and re-entering them before every demo is
# exactly the friction this script should not add.
if (Test-Path $envFile) {
    Write-Step "clearing the per-run tunnel credentials ..."
    $lines = Get-Content $envFile
    $wipe  = @("AGENT_TOOL_BASE_URL", "AGENT_TOOL_SECRET", "CORS_ORIGINS", "NEXT_PUBLIC_SLOW_LOOP_WS")
    $out = foreach ($line in $lines) {
        $key = if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { $Matches[1] } else { $null }
        if ($key -and $wipe -contains $key) { "$key=" } else { $line }
    }
    # UTF8 without BOM: a BOM on the first line makes the first key parse as
    # "﻿AGORA_APP_ID", which reads as missing and fails token issuance.
    #
    # Retried: `next dev` watches this file and holds a brief exclusive lock,
    # and a write landing in that window throws "being used by another
    # process". The services are stopped above so this is unlikely here, but
    # an editor or a slow-exiting watcher can still hold it for a moment.
    $written = $false
    for ($attempt = 1; $attempt -le 5 -and -not $written; $attempt++) {
        try {
            [System.IO.File]::WriteAllLines($envFile, $out, (New-Object System.Text.UTF8Encoding $false))
            $written = $true
        } catch {
            if ($attempt -eq 5) {
                Write-Bad "could not rewrite frontend\.env.local - it is locked"
                Write-Note "close whatever holds it and re-run, or clear these by hand:"
                Write-Note "  AGENT_TOOL_BASE_URL, AGENT_TOOL_SECRET, CORS_ORIGINS, NEXT_PUBLIC_SLOW_LOOP_WS"
            } else {
                Start-Sleep -Milliseconds 400
            }
        }
    }
    if ($written) { Write-Ok "tunnel credentials cleared (API keys kept)" }
}

# ── Build caches ────────────────────────────────────────────────────────────
if ($All) {
    Write-Step "removing build caches ..."

    $next = Join-Path $frontend ".next"
    if (Test-Path $next) {
        try {
            Remove-Item $next -Recurse -Force -ErrorAction Stop
            Write-Note "removed frontend/.next"
        } catch {
            Write-Note "could not remove frontend/.next - a file is still in use"
        }
    }

    $pycache = @(Get-ChildItem -Path $backend -Filter "__pycache__" -Recurse -Directory -ErrorAction SilentlyContinue |
                 Where-Object { $_.FullName -notlike "*\.venv\*" })
    foreach ($dir in $pycache) {
        try { Remove-Item $dir.FullName -Recurse -Force -ErrorAction Stop } catch { }
    }
    if ($pycache.Count -gt 0) { Write-Note "removed $($pycache.Count) __pycache__ director(ies)" }

    Write-Ok "build caches removed"
    Write-Note "the next start rebuilds, so it will be slower than usual"
}

# Per-run tunnel logs. Same filter start.ps1 uses to reap them.
$logs = @(Get-ChildItem -Path $env:TEMP -Filter "echosphere-*" -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match "^echosphere-(cloudflared|console)-" })
foreach ($log in $logs) {
    try { Remove-Item $log.FullName -Force -ErrorAction Stop } catch { }
}
if ($logs.Count -gt 0) { Write-Note "removed $($logs.Count) tunnel log file(s)" }

Write-Host ""
Write-Ok "EchoSphere is stopped and clean"
Write-Host ""
Write-Host "  Start fresh:" -ForegroundColor White
Write-Host "    .\start.ps1 -Tunnel          local demo, Echo can read the Ledger"
Write-Host "    .\start.ps1 -Share           ... and a public link for others"
Write-Host ""

# ── EXIT 0 EXPLICITLY, BECAUSE A NATIVE CALL ABOVE MAY HAVE FAILED ─────────
#
# A script with no `exit` returns $LASTEXITCODE, which is whatever the last
# EXTERNAL program set - and `docker ps` exits 1 when the daemon is not
# running. That is an expected, fully-handled condition here (the script
# prints "the Postgres container is not running" and carries on), but it
# still left the shell with a failing exit code.
#
# Measured: a completely successful `-Clean -Force` returned 1, so anything
# chaining off this script - CI, a `; if ($?)` sequence - would treat a good
# clean as a failure.
exit 0
