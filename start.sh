#!/usr/bin/env bash
# =============================================================================
# EchoSphere — Universal Cross-Platform Launcher
#
# When run under Git Bash, MINGW64, MSYS, or Cygwin on Windows, delegates cleanly
# to PowerShell with ExecutionPolicy Bypass so flags like -Tunnel and -Reset work.
# On native Linux / macOS, runs Docker Compose and coordinates the environment.
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Detect if running in Windows Git Bash / MSYS / MINGW
IS_WINDOWS=false
case "$(uname -s)" in
    CYGWIN*|MINGW*|MSYS*) IS_WINDOWS=true ;;
esac

if [ "$IS_WINDOWS" = true ]; then
    echo "Detected Windows Bash environment (Git Bash / MINGW). Delegating to PowerShell..."
    # Delegate all flags (-Tunnel, -Reset, etc.) to start.ps1
    exec powershell.exe -ExecutionPolicy Bypass -File "./start.ps1" "$@"
fi

# Native Linux / macOS path:
echo "Starting EchoSphere on Unix platform..."
docker compose up -d

echo "Starting backend and frontend..."
(cd backend && .venv/bin/uvicorn app.main:app --port 8000 &)
(cd frontend && npm run dev &)
wait

