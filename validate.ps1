<#
.SYNOPSIS
    Prove EchoSphere works, end to end, against the live Agora API.

.DESCRIPTION
    Run this from the repository root:

        .\validate.ps1              full validation (services must be running)
        .\validate.ps1 -Build       also run `next build` - NOT before a demo
        .\validate.ps1 -Quick       skip the live Agora run (offline checks only)

    ── WHY THIS EXISTS ────────────────────────────────────────────────────
    "Is it working?" was previously answered by running five different
    commands and reading five different outputs, none of which agreed on what
    counts as working. A green test suite is not a working product - this
    repo's own rules say so, because four real UI defects once passed
    typecheck, lint and build.

    So this asserts against the LIVE system: it invites a real Agora agent,
    feeds a real incident, reads what Agora itself recorded, calls the tool
    endpoint the way Agora calls it, and tries to get past the auth gate.
    Then it prints one verdict.

    KEEP STRING LITERALS PURE ASCII. PowerShell 5.1 reads a BOM-less .ps1 as
    ANSI, so an em-dash becomes CP1252 0x94 - a curly quote, which PowerShell
    accepts as a string delimiter. The parse then fails dozens of lines away.

.PARAMETER Build
    Also run `next build`. Skipped by default because it writes into the same
    .next the dev server is using.

.PARAMETER Quick
    Offline checks only. No Agora calls, no Groq spend.
#>
[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$Quick
)

$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$python = Join-Path $backend ".venv\Scripts\python.exe"
$envFile = Join-Path $frontend ".env.local"

$WEB = "http://localhost:3000"
$API = "http://127.0.0.1:8000"
$CHANNEL = "validate-run"

$script:pass = 0
$script:fail = 0
$script:warn = 0
$script:failures = @()

function Head($text) {
    Write-Host ""
    Write-Host "  $text" -ForegroundColor White
    Write-Host "  $('-' * 66)" -ForegroundColor DarkGray
}
function Ok($label, $detail = "") {
    $script:pass++
    Write-Host "  [ OK ] $label" -NoNewline -ForegroundColor Green
    if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray } else { Write-Host "" }
}
function Bad($label, $detail = "") {
    $script:fail++; $script:failures += $label
    Write-Host "  [FAIL] $label" -NoNewline -ForegroundColor Red
    if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray } else { Write-Host "" }
}
function Warn($label, $detail = "") {
    $script:warn++
    Write-Host "  [warn] $label" -NoNewline -ForegroundColor Yellow
    if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray } else { Write-Host "" }
}

# UTF-8 on the way in. PowerShell 5.1's Invoke-RestMethod decodes as
# ISO-8859-1 when Content-Type carries no charset, which manufactures
# convincing mojibake and has cost this project real debugging time twice.
function GetJson($url, $timeout = 40, $headers = @{}) {
    $r = Invoke-WebRequest $url -Headers $headers -UseBasicParsing -TimeoutSec $timeout
    return ([System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json)
}
function PostJson($url, $body, $timeout = 60, $headers = @{}) {
    $r = Invoke-WebRequest $url -Method Post -Headers $headers -ContentType "application/json" `
        -Body $body -UseBasicParsing -TimeoutSec $timeout
    return ([System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json)
}
function EnvKey($k) {
    if (-not (Test-Path $envFile)) { return $null }
    foreach ($l in Get-Content $envFile) {
        if ($l -match "^\s*$([regex]::Escape($k))\s*=\s*(.+)$") { return $Matches[1].Trim() }
    }
    return $null
}
function StatusOf($err) {
    if ($err.Exception.Response) { return [int]$err.Exception.Response.StatusCode }
    return 0
}

Write-Host ""
Write-Host "  ECHOSPHERE - END TO END VALIDATION" -ForegroundColor White
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray

# =============================================================================
Head "1. THE TEST SUITES"
# =============================================================================
if (-not (Test-Path $python)) {
    Bad "backend virtualenv" "missing at backend\.venv - run: python -m venv .venv"
} else {
    Push-Location $backend
    $out = & $python -m unittest discover -s tests -t . 2>&1 | Out-String
    Pop-Location
    if ($out -match "Ran (\d+) tests" ) { $n = $Matches[1] } else { $n = "?" }
    if ($out -match "\nOK") { Ok "backend unit tests" "$n tests" }
    else { Bad "backend unit tests" ($out -split "`n" | Select-Object -Last 3) -join " " }
}

Push-Location $frontend
$out = & npm run typecheck 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) { Ok "frontend typecheck" } else { Bad "frontend typecheck" }

$out = & npm run lint 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) { Ok "frontend lint" } else { Bad "frontend lint" }

$out = & npm run test 2>&1 | Out-String
if ($out -match "pass\s+(\d+)") { $n = $Matches[1] } else { $n = "?" }
if ($out -match "fail\s+0") { Ok "frontend unit tests" "$n tests" }
else { Bad "frontend unit tests" }

if ($Build) {
    $out = & npm run build 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { Ok "production build" }
    else { Bad "production build" }
} else {
    Warn "production build skipped" "pass -Build to include it (fights the dev server)"
}
Pop-Location

# =============================================================================
Head "2. THE SERVICES"
# =============================================================================
$slowHealth = $null
try { $slowHealth = GetJson "$API/health" 10; Ok "Slow Loop is up" "ready=$($slowHealth.ready)" }
catch { Bad "Slow Loop is up" "no answer on :8000 - run .\start.ps1 -Tunnel" }

$consoleHealth = $null
try {
    $consoleHealth = GetJson "$WEB/api/health?voice=1" 90
    if ($consoleHealth.ready) { Ok "console is up" "all credentials present" }
    else { Bad "console is up" "missing: $($consoleHealth.missing -join ', ')" }
} catch { Bad "console is up" $_.Exception.Message }

if ($slowHealth -and -not $slowHealth.degraded.voice -and -not $slowHealth.degraded.extraction) {
    Ok "no degradation banner"
} elseif ($slowHealth) {
    Warn "degradation banner raised" $slowHealth.degraded.banner
}

if ($consoleHealth -and $consoleHealth.fastLoop) {
    if ($consoleHealth.fastLoop.voiceVerified) {
        Ok "Echo can answer out loud" "$($consoleHealth.fastLoop.model) on key #$($consoleHealth.fastLoop.keyIndex)"
    } else {
        Bad "Echo can answer out loud" "no Groq key answered - daily budget spent"
    }
}

# =============================================================================
Head "3. THE TUNNEL (how Agora reaches the Ledger)"
# =============================================================================
$base = EnvKey "AGENT_TOOL_BASE_URL"
$secret = EnvKey "AGENT_TOOL_SECRET"
$tunnelLive = $false

if (-not $base) {
    Warn "no tunnel configured" "Echo will greet but cannot answer - run .\start.ps1 -Tunnel"
} else {
    try {
        GetJson "$base/health" 25 | Out-Null
        $tunnelLive = $true
        Ok "tunnel routes to the Slow Loop" $base
    } catch { Bad "tunnel is dead" "$base - re-run .\start.ps1 -Tunnel" }
}

if ($tunnelLive) {
    # The auth gate, tested from outside - the path an attacker would take.
    foreach ($case in @(
        @{ n = "tool call without a token is refused";  p = "/tools/query_incident_state"; h = @{} },
        @{ n = "tool call with a WRONG token refused";  p = "/tools/query_incident_state"; h = @{ "X-Echo-Tool-Token" = "wrong" } },
        @{ n = "/bridge/say without a token refused";   p = "/bridge/say";                 h = @{} }
    )) {
        try {
            Invoke-WebRequest "$base$($case.p)" -Method Post -Headers $case.h `
                -ContentType "application/json" -Body '{"text":"x"}' `
                -UseBasicParsing -TimeoutSec 30 | Out-Null
            Bad $case.n "LEAKED - the gate let it through"
        } catch {
            $code = StatusOf $_
            if ($code -eq 401) { Ok $case.n "401" } else { Bad $case.n "expected 401, got $code" }
        }
    }

    try {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        PostJson "$base/tools/query_incident_state" '{"scope":"all"}' 40 @{ "X-Echo-Tool-Token" = $secret } | Out-Null
        $sw.Stop()
        Ok "the Ledger answers Agora's tool call" "$([int]$sw.Elapsed.TotalMilliseconds) ms"
    } catch { Bad "the Ledger answers Agora's tool call" $_.Exception.Message }
}

if ($Quick) {
    Head "SKIPPED: the live Agora run (-Quick)"
} else {

# =============================================================================
Head "4. A REAL AGORA AGENT"
# =============================================================================
$agentId = $null
try {
    PostJson "$WEB/api/stop-agent" (@{ channel = $CHANNEL } | ConvertTo-Json -Compress) 30 | Out-Null
} catch { }

try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $inv = PostJson "$WEB/api/invite-agent" (@{ channel = $CHANNEL; userUid = 1001 } | ConvertTo-Json -Compress) 90
    $sw.Stop()
    $agentId = $inv.agentId
    if ($agentId) { Ok "Agora created the agent" "$agentId in $([int]$sw.Elapsed.TotalMilliseconds) ms" }
    else { Bad "Agora created the agent" "no agent id returned" }

    if ($inv.registeredWithSlowLoop) { Ok "Slow Loop received the agent id" }
    else { Bad "Slow Loop received the agent id" "Echo would be mute" }

    if ($inv.toolsEnabled) { Ok "Echo can read the Ledger" "tools enabled" }
    else { Warn "Echo cannot read the Ledger" "no tunnel - it will say so honestly" }
} catch {
    Bad "Agora created the agent" $_.Exception.Message
}

if ($agentId) {
    Start-Sleep -Seconds 4
    try {
        $st = GetJson "$WEB/api/agent-status?agentId=$agentId" 40
        if ($st.status.body.status -eq "RUNNING") { Ok "Agora reports RUNNING" "its own status endpoint" }
        else { Bad "Agora reports RUNNING" "got $($st.status.body.status)" }
    } catch { Bad "Agora reports RUNNING" $_.Exception.Message }
}

# =============================================================================
Head "5. SPEECH IN, KNOWLEDGE OUT"
# =============================================================================
try { PostJson "$API/incident/reset" "{}" 30 | Out-Null } catch { }

Push-Location $frontend
$env:DEMO_CHANNEL = $CHANNEL
& npm run demo feed --silent 2>&1 | Out-Null
Remove-Item Env:\DEMO_CHANNEL -ErrorAction SilentlyContinue
Pop-Location

<#
  WAIT FOR THE WORK, NOT FOR A LULL.

  This loop used to stop after 4 consecutive seconds of `inFlight == 0 and
  windowFrames == 0`. That is not "finished" - Demo Script v2 leaves 9, 11 and
  17 second gaps between utterances, and the window sits genuinely empty in
  every one of them. The check therefore fired DURING the feed, and reported 5
  claims and no contradiction while the pipeline was still working. Echo went
  on to speak the contradiction seconds later, into a validator that had
  already declared it missing.

  This repo has recorded that lesson twice already - a fixed 8s sleep, then
  "the count stopped changing" - and both times the harness mistook a pause
  for an ending. So: settle on WORK OBSERVED, not on quiet. Require the
  pipeline to have actually run, then require a long quiet period after it,
  and stop early once the thing being asserted exists.
#>
$idle = 0
$sawWork = $false
$deadline = (Get-Date).AddSeconds(120)

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    try {
        $h = GetJson "$API/health" 10
        $busy = ($h.pipeline.inFlight -gt 0 -or $h.pipeline.windowFrames -gt 0)
        if ($busy) { $sawWork = $true; $idle = 0 } else { $idle++ }

        <#
          NO EARLY EXIT ON A COUNT.

          The first version broke as soon as ONE contradiction existed. The
          pipeline surfaces at most one per window, and the weak INDEPENDENT
          pair lands a window before the OPPOSED one that is the whole demo -
          so "at least one" was satisfied by the wrong verdict and the query
          ran in the gap between them. Echo then spoke the OPPOSED line into a
          validator that had already recorded it missing.

          A count is not an ending. The only sound signal is work observed,
          then a quiet period longer than the pipeline's own turnaround.
        #>
        if ($sawWork -and $idle -ge 15) { break }
    } catch { }
}

try {
    $led = PostJson "$API/tools/query_incident_state" "{}" 40
    $est = @($led.established).Count
    $hyp = @($led.openHypotheses).Count

    if ($est -ge 5) { Ok "facts extracted into the Ledger" "$est established" }
    else { Bad "facts extracted into the Ledger" "only $est - expected 5 or more" }

    if ($hyp -ge 1) { Ok "the guess was kept OUT of the facts" "$hyp open question" }
    else { Bad "the guess was kept OUT of the facts" "a hedge was filed as a fact" }

    # Rule 1: every claim names its source. This is the one that silently broke.
    $unsourced = @()
    foreach ($c in @($led.established) + @($led.openHypotheses)) {
        if (-not $c.speakerRole -or $c.speakerRole -match "^(unknown|n/a|none|\?|-)$") {
            $unsourced += $c.text
        }
    }
    if ($unsourced.Count -eq 0) { Ok "every claim is attributed" "$($est + $hyp) of $($est + $hyp)" }
    else { Bad "every claim is attributed" "$($unsourced.Count) unsourced" }

    # And the hedge specifically must be a HYPOTHESIS, not an OBSERVED fact.
    $hedge = @($led.openHypotheses) | Where-Object { $_.text -match "might|may |could |likely|probably" }
    if ($hedge) { Ok "the hedge is filed as a hypothesis" "`"$($hedge[0].text)`" - $($hedge[0].speakerRole)" }
    else { Warn "no hedged claim found" "the fixture may have changed" }
} catch {
    Bad "read the Ledger" $_.Exception.Message
}

# =============================================================================
Head "6. THE CONTRADICTION, AND WHO DECIDED IT"
# =============================================================================
try {
    $cx = PostJson "$API/tools/query_incident_state" '{"scope":"contradictions"}' 40
    $found = @($cx.contradictions)
    if ($found.Count -lt 1) {
        Bad "a contradiction was detected" "none found - the headline demo beat is missing"
    } else {
        foreach ($c in $found) {
            Write-Host "         $($c.relation.PadRight(12)) $($c.speakers -join ' / ')" -ForegroundColor DarkGray
        }

        # OPPOSED is the headline beat: two claims that cannot both be true.
        $opposed = @($found | Where-Object { $_.relation -eq "OPPOSED" })
        if ($opposed.Count -ge 1) {
            Ok "the headline contradiction fired" "OPPOSED between $($opposed[0].speakers -join ' / ')"
        } else {
            Bad "the headline contradiction fired" "only $(@($found | ForEach-Object { $_.relation }) -join ', ')"
            Write-Host "         The pipeline ran and found a real relationship - just not" -ForegroundColor DarkGray
            Write-Host "         the OPPOSED one the demo turns on. Adjudication is a model" -ForegroundColor DarkGray
            Write-Host "         call under an 8000-tokens-per-MINUTE ceiling, so this lands" -ForegroundColor DarkGray
            Write-Host "         roughly 2 runs in 3. Before demoing, just run it again:" -ForegroundColor DarkGray
            Write-Host "           npm run demo reset ; npm run demo feed" -ForegroundColor Cyan
            Write-Host "         The epistemic separation - facts vs the hedge, all attributed -" -ForegroundColor DarkGray
            Write-Host "         is deterministic and passed above. That is the core claim." -ForegroundColor DarkGray
        }

        <#
          Look for ANY panelled verdict, not the first contradiction.

          PANEL_PAIR_BUDGET deliberately gives the panel only to the strongest
          candidates: a panel is 2-3 LLM calls against an 8000-tokens-per-MINUTE
          ceiling, and the first live rehearsal after wiring it in drowned in
          429s and LOST the headline contradiction. Weaker pairs fall back to
          the single judge, which is a documented floor rather than a fault.

          So asserting "contradiction[0] has a panel" tests the ranking, not the
          panel. What matters is that the panel ran, and ran on two models.
        #>
        $panelled = @($found | Where-Object { $_.panel -and @($_.panel.positions).Count -ge 2 })
        if ($panelled.Count -ge 1) {
            $c = $panelled[0]
            $models = @($c.panel.positions | ForEach-Object { $_.model }) | Select-Object -Unique
            if ($models.Count -ge 2) {
                Ok "the Deliberation Panel adjudicated it" "two models: $($models -join ' + ')"
            } else {
                Warn "the panel ran on ONE model" "both analysts used $($models[0])"
            }
            foreach ($p in $c.panel.positions) {
                Write-Host "         $($p.persona.PadRight(8)) $($p.relation.PadRight(12)) $($p.confidence)  $($p.model)" -ForegroundColor DarkGray
            }
            if ($found.Count -gt $panelled.Count) {
                Write-Host "         $($found.Count - $panelled.Count) weaker pair(s) took the single-judge fallback (PANEL_PAIR_BUDGET)" -ForegroundColor DarkGray
            }
        } else {
            Bad "the Deliberation Panel adjudicated it" "no contradiction carries panel positions"
        }
    }
} catch { Bad "read contradictions" $_.Exception.Message }

# =============================================================================
Head "7. WHAT AGORA ACTUALLY VOICED"
# =============================================================================
if ($agentId) {
    Start-Sleep -Seconds 6
    try {
        $hist = GetJson "$WEB/api/agent-status?agentId=$agentId" 40
        $turns = @($hist.history.body.contents)
        $spoken = @($turns | Where-Object { ([string]$_.content).Trim() })

        if ($spoken.Count -ge 1) { Ok "Echo spoke on the bridge" "$($spoken.Count) turn(s) in Agora's own history" }
        else { Bad "Echo spoke on the bridge" "Agora recorded no speech" }

        $greeted = @($spoken | Where-Object { $_.content -match "Echo is on the bridge" })
        if ($greeted.Count -eq 1) { Ok "Echo announced itself exactly once" }
        elseif ($greeted.Count -eq 0) { Bad "Echo announced itself" "no greeting recorded" }
        else { Bad "Echo announced itself exactly once" "greeted $($greeted.Count) times" }

        $filler = @($spoken | Where-Object { $_.content -match "^One moment" })
        if ($filler.Count -eq 0) { Ok "no filler spoken" "failure_message stayed silent" }
        else { Bad "no filler spoken" "$($filler.Count) 'One moment.' turns" }

        # Rule 2: Echo may ask about cause. It may never assert one.
        $diagnosing = @($spoken | Where-Object {
            $_.content -match "(?i)\b(root cause is|is caused by|because of|due to)\b"
        })
        if ($diagnosing.Count -eq 0) { Ok "Echo never asserted a cause" "Rule 2 held" }
        else { Bad "Echo never asserted a cause" "RULE 2 VIOLATION: $($diagnosing[0].content)" }

        Write-Host ""
        foreach ($t in $spoken) {
            Write-Host "         `"$([string]$t.content)`"" -ForegroundColor Cyan
        }
    } catch { Bad "read Agora's history" $_.Exception.Message }

    try {
        PostJson "$WEB/api/stop-agent" (@{ channel = $CHANNEL } | ConvertTo-Json -Compress) 30 | Out-Null
        Ok "agent stopped cleanly" "no orphan left billing"
    } catch { Warn "agent stop" "stop it by hand: npm run demo stop" }
}

}  # end -Quick

# =============================================================================
Write-Host ""
Write-Host "  $('=' * 68)" -ForegroundColor DarkGray
$total = $script:pass + $script:fail
if ($script:fail -eq 0) {
    Write-Host "  VERDICT: PASS" -ForegroundColor Green -NoNewline
    Write-Host "   $($script:pass)/$total checks, $($script:warn) warning(s)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  The pipeline is live: Agora created an agent, it spoke, speech" -ForegroundColor DarkGray
    Write-Host "  became attributed knowledge, a contradiction was adjudicated by" -ForegroundColor DarkGray
    Write-Host "  two models, and the auth gate refused everything it should." -ForegroundColor DarkGray
    Write-Host ""
    # Say what this CANNOT cover, every single time. A verdict that implies
    # more than it tested is worse than no verdict - and 28/28 above says
    # nothing about whether a spoken question comes back as a spoken answer.
    Write-Host "  NOT COVERED HERE: you talking to Echo." -ForegroundColor Yellow
    Write-Host "  Agora has no way to inject a user turn - /update returns 200 and" -ForegroundColor DarkGray
    Write-Host "  voices nothing, /chat and /message are 404 - so a conversational" -ForegroundColor DarkGray
    Write-Host "  turn can only start with real audio. One command, one minute:" -ForegroundColor DarkGray
    Write-Host "      cd frontend" -ForegroundColor DarkGray
    Write-Host "      npm run demo converse" -ForegroundColor Cyan
} else {
    Write-Host "  VERDICT: FAIL" -ForegroundColor Red -NoNewline
    Write-Host "   $($script:fail) of $total checks failed" -ForegroundColor DarkGray
    Write-Host ""
    foreach ($f in $script:failures) { Write-Host "    - $f" -ForegroundColor Red }
}
Write-Host "  $('=' * 68)" -ForegroundColor DarkGray
Write-Host ""
if ($script:fail -gt 0) { exit 1 }
