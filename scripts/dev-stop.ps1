# Stop everything the dev stack starts.  npm run dev:stop
#
# WHY THIS IS MORE THAN A PORT KILL: `shopify app dev` binds the ports (3000,
# plus a proxy port), but the actual app server is a CHILD `react-router dev`
# (Vite) process that listens on NEITHER. Windows does not kill children with
# their parent, so a port-only stop leaves one orphaned Vite server behind on
# every cycle. Those orphans hold a lock on the Prisma query engine, which is
# what makes `prisma generate` fail with EPERM and leaves a stale Prisma client
# in memory (2026-08-20: eight of them had stacked up across one day).

$ErrorActionPreference = 'SilentlyContinue'
$targets = @()

# 1. Whatever is listening on the dev ports (Shopify CLI proxy, Vite, Studio…).
foreach ($port in 3000, 3457, 9292, 9293, 5555) {
  Get-NetTCPConnection -LocalPort $port -State Listen | ForEach-Object {
    $targets += [pscustomobject]@{ Id = $_.OwningProcess; Why = "port $port" }
  }
}

# 2. Any dev server belonging to THIS project, listening or not. Matching on the
#    command line keeps unrelated Node apps (and the Shopify MCP server) safe.
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'node.exe' -and
    $_.CommandLine -like '*chat-convert*' -and
    ($_.CommandLine -like '*@react-router*' -or $_.CommandLine -like '*vite*')
  } |
  ForEach-Object { $targets += [pscustomobject]@{ Id = $_.ProcessId; Why = 'project dev server' } }

$seen = @{}
foreach ($t in $targets) {
  if ($seen.ContainsKey($t.Id)) { continue }
  $seen[$t.Id] = $true
  $proc = Get-Process -Id $t.Id
  if (-not $proc) { continue }
  Write-Host ("Stopping PID {0} ({1}) - {2}" -f $t.Id, $proc.ProcessName, $t.Why)
  # /T kills the process tree, so a CLI parent takes its Vite child with it.
  & taskkill /T /F /PID $t.Id 2>&1 | Out-Null
}

# 3. Orphaned Prisma query engines for this project (they hold the .dll/.exe lock).
Get-Process query-engine-windows | Where-Object { $_.Path -like '*chat-convert*' } | ForEach-Object {
  Write-Host ("Stopping orphaned Prisma engine PID {0}" -f $_.Id)
  Stop-Process -Id $_.Id -Force
}

Start-Sleep -Milliseconds 400

# 4. Report anything that survived, so a failed stop is visible instead of silent.
$left = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -like '*chat-convert*' -and
  ($_.CommandLine -like '*@react-router*' -or $_.CommandLine -like '*vite*')
}
if ($left) {
  Write-Host 'WARNING - these dev servers are still running:' -ForegroundColor Yellow
  $left | ForEach-Object { Write-Host ("  PID {0}" -f $_.ProcessId) }
} else {
  Write-Host 'Dev stack stopped - no project dev servers remain.' -ForegroundColor Green
}

exit 0
