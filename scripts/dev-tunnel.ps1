# Start dev against a tunnel.  npm run dev:tunnel
#
# Prefers a STABLE ngrok domain, falls back to a cloudflared quick tunnel.
#
#   ngrok       — set NGROK_DOMAIN in .env (e.g. chatconvert-dev.ngrok-free.app).
#                 The hostname never changes, so the app-proxy URL in the Shopify
#                 dashboard is set ONCE and never touched again.
#   cloudflared — no NGROK_DOMAIN set. Works, but the hostname changes on every
#                 cloudflared restart, and Shopify's app-proxy URL must then be
#                 re-entered by hand in the Dev Dashboard. That cost is the whole
#                 reason the ngrok path exists.
#
# Order matters:
#   1. stop first  — otherwise each start leaves an orphaned Vite server behind
#      and they stack up (see scripts/dev-stop.ps1)
#   2. prisma generate — with everything stopped the engine file is unlocked, so
#      this can't hit EPERM; it also guarantees the running server's Prisma
#      client matches the current schema (a stale client is invisible: pages
#      just fail at the query)
#   3. point shopify.app.dev.toml's three URLs at the tunnel — including
#      [app_proxy].url, which the CLI does NOT manage and which the storefront
#      widget depends on entirely
#   4. hand the tunnel hostname to the Shopify CLI

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# --- Which tunnel? ---------------------------------------------------------
$ngrokDomain = $null
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^\s*NGROK_DOMAIN\s*=\s*(.+)\s*$' | Select-Object -First 1
  if ($line) {
    $ngrokDomain = $line.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'")
    if ($ngrokDomain -eq '') { $ngrokDomain = $null }
  }
}

Write-Host '[1/4] Stopping any running dev servers...' -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dev-stop.ps1')

Write-Host '[2/4] Refreshing the Prisma client...' -ForegroundColor Cyan
Push-Location $root
try {
  # Merge stderr in CMD, not PowerShell. `& npx ... 2>&1` makes PowerShell 5.1
  # wrap each stderr line in a NativeCommandError ErrorRecord, which the
  # script-wide $ErrorActionPreference = 'Stop' then treats as fatal - so npm's
  # own `shamefully-hoist` warning killed the script before prisma even ran.
  # cmd does the merge and hands PowerShell plain strings.
  $genOutput = cmd /c "npx prisma generate 2>&1"
  if ($LASTEXITCODE -ne 0) {
    $genOutput | ForEach-Object { Write-Host $_ }
    Write-Host ''
    Write-Host 'prisma generate failed - fix that before starting dev (stale client = failing queries).' -ForegroundColor Red

    # EPERM on the engine rename is almost never a Prisma problem: some other
    # process in this project still has query-engine-windows.exe mapped, and
    # Windows will not rename over an open file. dev-stop.ps1 only kills dev
    # SERVERS (@react-router / vite), so a `tsx` script - eval:golden, smoke,
    # a QA suite, prisma studio - survives it and holds the lock. Name the
    # culprit rather than leaving a bare EPERM.
    if ($genOutput -match 'EPERM') {
      $holders = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -like '*chat-convert*'
      }
      if ($holders) {
        Write-Host ''
        Write-Host 'These project processes are still running and are the likely cause:' -ForegroundColor Yellow
        foreach ($h in $holders) {
          $cmd = $h.CommandLine
          if ($cmd.Length -gt 110) { $cmd = $cmd.Substring(0, 110) + '...' }
          Write-Host ("  PID {0}  {1}" -f $h.ProcessId, $cmd)
        }
        Write-Host ''
        Write-Host 'Let them finish, or: taskkill /T /F /PID <pid>' -ForegroundColor Yellow
      }
    }
    exit 1
  }
} finally {
  Pop-Location
}

# --- Resolve the tunnel ----------------------------------------------------
Write-Host '[3/4] Resolving the tunnel...' -ForegroundColor Cyan
$url = $null

if ($ngrokDomain) {
  # Is the binary even there? Windows Defender flags ngrok as
  # Trojan:Win32/Kepavll!rfn (a known heuristic false positive on tunneling
  # tools) and DELETES it, which otherwise shows up here as the far less
  # obvious "ngrok is not running".
  if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
    Write-Host 'ngrok is not installed (or Defender removed it).' -ForegroundColor Red
    Write-Host 'In an ADMIN PowerShell:' -ForegroundColor Yellow
    Write-Host '  Add-MpPreference -ExclusionPath "C:\Users\progr\AppData\Local\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe"'
    Write-Host '  winget install ngrok.ngrok --force --silent --accept-package-agreements --accept-source-agreements'
    Write-Host 'Then in a normal terminal: ngrok update    (the winget build is too old for ngrok accounts)'
    Write-Host ''
    Write-Host 'Or comment out NGROK_DOMAIN in .env to fall back to cloudflared.' -ForegroundColor Yellow
    exit 1
  }

  # ngrok's local agent API lists what it is currently forwarding. Confirm the
  # agent is up AND serving the reserved domain before handing it to the CLI -
  # a mismatch here is far cheaper to catch now than as a 404 in the storefront.
  try {
    $api = Invoke-RestMethod http://127.0.0.1:4040/api/tunnels -TimeoutSec 3
  } catch {
    Write-Host "ngrok is not running. Start it first (leave it up all day):" -ForegroundColor Yellow
    Write-Host ("  ngrok http 3000 --domain={0}" -f $ngrokDomain)
    exit 1
  }
  $match = $api.tunnels | Where-Object { $_.public_url -eq ("https://" + $ngrokDomain) } | Select-Object -First 1
  if (-not $match) {
    Write-Host ("ngrok is running but is not serving https://{0}." -f $ngrokDomain) -ForegroundColor Yellow
    Write-Host 'Currently forwarding:'
    $api.tunnels | ForEach-Object { Write-Host ("  {0} -> {1}" -f $_.public_url, $_.config.addr) }
    Write-Host ''
    Write-Host ("Restart it as: ngrok http 3000 --domain={0}" -f $ngrokDomain) -ForegroundColor Yellow
    exit 1
  }
  $url = "https://" + $ngrokDomain
  Write-Host ("Using ngrok (stable) {0}" -f $url) -ForegroundColor Green
} else {
  try {
    $r = Invoke-RestMethod http://127.0.0.1:20241/quicktunnel -TimeoutSec 2
  } catch {
    Write-Host 'No NGROK_DOMAIN in .env, and cloudflared is not running either.' -ForegroundColor Yellow
    Write-Host 'Start one of them:'
    Write-Host '  ngrok http 3000 --domain=<your-reserved-domain>        (stable - preferred)'
    Write-Host '  cloudflared tunnel --url http://localhost:3000 --metrics 127.0.0.1:20241'
    exit 1
  }
  if (-not $r.hostname) {
    Write-Host 'cloudflared responded but reported no hostname - restart the tunnel.' -ForegroundColor Yellow
    exit 1
  }
  $url = 'https://' + $r.hostname
  Write-Host ("Using cloudflared quick tunnel {0}" -f $url) -ForegroundColor Green
  Write-Host 'Hostname changes on every restart - you must re-enter the app-proxy URL' -ForegroundColor Yellow
  Write-Host 'in the Shopify Dev Dashboard each time. Set NGROK_DOMAIN in .env to stop that.' -ForegroundColor Yellow
}

# --- Point the dev config at it -------------------------------------------
Write-Host '[4/4] Pointing shopify.app.dev.toml at the tunnel...' -ForegroundColor Cyan
Push-Location $root
try {
  & node (Join-Path $PSScriptRoot 'sync-dev-urls.cjs') $url
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Could not update shopify.app.dev.toml - fix that first, or the widget will 404.' -ForegroundColor Red
    exit 1
  }
} finally {
  Pop-Location
}

Push-Location $root
try {
  & npm run dev -- --tunnel-url ($url + ':3000')
} finally {
  Pop-Location
}
