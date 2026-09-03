<#
.SYNOPSIS
    Start EchoSphere — both services, then the pre-flight.

.DESCRIPTION
    Run this from the repository root:

        .\start.ps1

    ── WHY THIS EXISTS ────────────────────────────────────────────────────
    The README's two-terminal instructions were written with `&&`, which is a
    PARSE ERROR in Windows PowerShell 5.1 — the shell this project is actually
    developed in. `cd backend && python ...` does not run and does not explain
    itself; it just fails to parse, which looks like the project is broken.

    Shell syntax is not something anyone should have to think about ninety
    seconds before a demo. This script starts the Slow Loop and the console,
    waits until both genuinely answer, and runs the pre-flight.

.PARAMETER SkipPreflight
    Start the services without running the pre-flight check.

.PARAMETER Reset
    Clear the incident board and stop any leftover agent before checking.
#>
[CmdletBinding()]
param(
    [switch]$SkipPreflight,
    [switch]$Reset
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$python = Join-Path $backend ".venv\Scripts\python.exe"

function Write-Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  OK   $text" -ForegroundColor Green }
function Write-Bad($text)  { Write-Host "  FAIL $text" -ForegroundColor Red }

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
Write-Host "    then, in this window:  cd frontend"
Write-Host "                           npm run demo feed"
Write-Host ""
