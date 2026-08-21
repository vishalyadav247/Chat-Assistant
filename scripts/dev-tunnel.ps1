# Start dev against the self-managed cloudflared tunnel.  npm run dev:tunnel
#
# Order matters:
#   1. stop first  — otherwise each start leaves an orphaned Vite server behind
#      and they stack up (see scripts/dev-stop.ps1)
#   2. prisma generate — with everything stopped the engine file is unlocked, so
#      this can't hit EPERM; it also guarantees the running server's Prisma
#      client matches the current schema (a stale client is invisible: pages
#      just fail at the query)
#   3. hand the tunnel hostname to the Shopify CLI
#
# Requires cloudflared running in its own window (leave it up all day):
#   cloudflared tunnel --url http://localhost:3000 --metrics 127.0.0.1:20241

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host '[1/3] Stopping any running dev servers...' -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dev-stop.ps1')

Write-Host '[2/3] Refreshing the Prisma client...' -ForegroundColor Cyan
Push-Location $root
try {
  & npx prisma generate | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'prisma generate failed - fix that before starting dev (stale client = failing queries).' -ForegroundColor Red
    exit 1
  }
} finally {
  Pop-Location
}

Write-Host '[3/3] Resolving the cloudflared quick tunnel...' -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod http://127.0.0.1:20241/quicktunnel -TimeoutSec 2
} catch {
  Write-Host 'cloudflared is not running. Start it first (leave it running all day):' -ForegroundColor Yellow
  Write-Host '  cloudflared tunnel --url http://localhost:3000 --metrics 127.0.0.1:20241'
  exit 1
}
if (-not $r.hostname) {
  Write-Host 'cloudflared responded but reported no hostname - restart the tunnel.' -ForegroundColor Yellow
  exit 1
}

$url = 'https://' + $r.hostname
Write-Host ("Using tunnel {0}" -f $url) -ForegroundColor Green
Push-Location $root
try {
  & npm run dev -- --tunnel-url ($url + ':3000')
} finally {
  Pop-Location
}
