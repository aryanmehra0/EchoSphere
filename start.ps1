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
#>
[CmdletBinding()]
param(
    [switch]$SkipPreflight,
    [switch]$Reset,
    [switch]$Tunnel
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$python = Join-Path $backend ".venv\Scripts\python.exe"
$envFile = Join-Path $frontend ".env.local"

function Write-Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  OK   $text" -ForegroundColor Green }
function Write-Bad($text)  { Write-Host "  FAIL $text" -ForegroundColor Red }
function Write-Note($text) { Write-Host "       $text" -ForegroundColor DarkGray }

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
    Set-Content -Path $envFile -Value $out -Encoding UTF8
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
    $cf = Get-Command cloudflared -ErrorAction SilentlyContinue
    if (-not $cf) {
        Write-Bad "cloudflared is not installed"
        Write-Note "winget install --id Cloudflare.cloudflared"
        Write-Note "or run without -Tunnel; Echo will talk but cannot read the Ledger."
        exit 1
    }

    Write-Step "opening a tunnel to the Slow Loop ..."
    $tlog = Join-Path $env:TEMP "echosphere-cloudflared.log"
    if (Test-Path $tlog) { Remove-Item $tlog -Force }

    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    Start-Process -FilePath $cf.Source `
        -ArgumentList "tunnel", "--url", "http://localhost:8000", "--logfile", $tlog `
        -WindowStyle Hidden

    foreach ($i in 1..45) {
        Start-Sleep -Milliseconds 1000
        if (Test-Path $tlog) {
            $m = Select-String -Path $tlog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" `
                 -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($m) { $tunnelUrl = $m.Matches[0].Value; break }
        }
    }

    if (-not $tunnelUrl) {
        Write-Bad "the tunnel did not come up"
        Write-Note "log: $tlog"
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
    Write-Ok "tool credentials written to frontend\.env.local"

    # Both processes cached the old environment. Restart them.
    foreach ($port in 8000, 3000) {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($conn) {
            Write-Note "restarting the service on :$port to pick up the new tunnel"
            Stop-Process -Id $conn[0].OwningProcess -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 1200
        }
    }
}

# ── Slow Loop ───────────────────────────────────────────────────────────────
$slowLoop = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($slowLoop) {
    Write-Ok "Slow Loop already running on :8000"
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
$console = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($console) {
    Write-Ok "console already running on :3000"
} else {
    Write-Step "starting the console on :3000 ..."
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev" `
        -WorkingDirectory $frontend -WindowStyle Hidden

    $up = $false
    foreach ($i in 1..60) {
        Start-Sleep -Milliseconds 900
        try {
            $r = Invoke-WebRequest "http://localhost:3000" -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { $up = $true; break }
        } catch { }
    }
    if ($up) { Write-Ok "console is up" }
    else {
        Write-Bad "the console did not start"
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
if ($tunnelUrl) {
    try {
        $probe = Invoke-RestMethod "$tunnelUrl/health" -TimeoutSec 20
        if ($probe.ready) { Write-Ok "Agora can reach the Ledger through the tunnel" }
        else { Write-Bad "the tunnel routes, but the Slow Loop is not ready" }
    } catch {
        Write-Bad "the tunnel is up but does not route to the Slow Loop"
        Write-Note $_.Exception.Message
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

Write-Host "  Next:" -ForegroundColor White
Write-Host "    open http://localhost:3000 and press J"
if ($tunnelUrl) {
    Write-Host "    Echo will greet you out loud, then answer questions about the incident."
    Write-Host "    Try saying:  " -NoNewline
    Write-Host '"Echo, what do we know so far?"' -ForegroundColor Cyan
} else {
    Write-Host "    Echo will greet you out loud, but cannot read the Ledger."
    Write-Host "    For a real conversation, restart with:  " -NoNewline
    Write-Host ".\start.ps1 -Tunnel" -ForegroundColor Cyan
}
Write-Host "    then, in this window:  cd frontend"
Write-Host "                           npm run demo feed"
Write-Host ""
