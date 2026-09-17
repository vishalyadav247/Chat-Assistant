# Local half of the release flow (Windows / PowerShell 5.1).
#
#   npm run release -- "what changed and why"
#   npm run release:sync          # after the PR is merged on GitHub
#
# Does, in order: fetch, merge origin/main into dev, typecheck, lint, commit,
# push dev, then hand you the PR compare URL. Merging the PR stays manual —
# `gh` is not installed on this machine, and the compare view is the last place
# a stray secret or an unwanted migration can be caught before it reaches
# production.
#
# The server half is scripts/deploy.sh, run on the droplet after the merge.

param(
  # After the PR is merged: bring local main and dev level with origin and stop.
  [switch]$Sync,

  # Skip typecheck + lint. For doc-only changes; never for code.
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'

# The commit message is everything that is not one of the two switches above.
#
# Deliberately NOT a declared [string]$Message parameter, and deliberately no
# [CmdletBinding()]. npm strips quotes on the way through cmd.exe, so
#     npm run release -- -Message "a b c"
# arrives as `-Message a b c` - five separate arguments. A declared parameter
# binds only "a" and then dies with "A positional parameter cannot be found that
# accepts argument 'b'". ValueFromRemainingArguments does not save it either:
# once -Message is named explicitly, the leftovers have nowhere to go.
#
# Without CmdletBinding, everything unmatched lands in $args and nothing errors,
# so all of these produce the same message:
#     npm run release -- -Message "a b c"      (quotes stripped by npm)
#     npm run release -- "a b c"
#     powershell -File scripts/release.ps1 "a b c"
# A leading literal "-Message" is dropped for the sake of muscle memory.
$parts = @($args)
if ($parts.Count -gt 0 -and $parts[0] -eq '-Message') {
  $parts = if ($parts.Count -gt 1) { $parts[1..($parts.Count - 1)] } else { @() }
}
$MessageText = ($parts -join ' ').Trim()

function Fail([string]$text) {
  Write-Host ""
  Write-Host "  x $text" -ForegroundColor Red
  exit 1
}

function Step([string]$text) {
  Write-Host ""
  Write-Host "-> $text" -ForegroundColor Cyan
}

# Resolve the git BINARY once, explicitly as an Application.
#
# The helper below used to be called `Git`, and PowerShell resolves functions
# BEFORE external commands - so `& git ...` inside it found the function itself
# and recursed until "The script failed due to call depth overflow". Any helper
# named after the command it wraps has this trap. Both halves of the fix matter:
# the name no longer collides, and $GIT is a resolved path that cannot be
# shadowed by a function or alias later.
$GIT = (Get-Command git -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1).Source
if (-not $GIT) { Fail "git is not on PATH" }

function Invoke-Git {
  # Run git and stop the script on a non-zero exit. Output goes to the console
  # as it happens so a long fetch or a merge conflict is visible immediately.
  & $GIT @args
  if ($LASTEXITCODE -ne 0) { Fail "git $($args -join ' ') failed (exit $LASTEXITCODE)" }
}

# --- Locate the repo -------------------------------------------------------
$root = & $GIT rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0) { Fail "not inside a git repository" }
Set-Location $root

$REMOTE = 'origin'
$COMPARE = 'https://github.com/progryss/chatconvert/compare/main...dev'

Step "Fetching $REMOTE"
Invoke-Git fetch $REMOTE --prune

# --- Sync mode: post-merge cleanup, then exit ------------------------------
if ($Sync) {
  Step "Syncing local main and dev with $REMOTE (post-merge)"
  Invoke-Git checkout main
  # --ff-only on purpose: if this cannot fast-forward, local main has commits
  # of its own, which should never happen. Better to stop than to merge.
  Invoke-Git merge --ff-only "$REMOTE/main"
  Invoke-Git checkout dev
  Invoke-Git merge --no-edit main
  Invoke-Git push $REMOTE dev
  Write-Host ""
  Write-Host "  main and dev are level with $REMOTE." -ForegroundColor Green
  Write-Host "  Next: run scripts/deploy.sh on the droplet." -ForegroundColor Green
  exit 0
}

# --- Must be on dev --------------------------------------------------------
$branch = (& $GIT rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'dev') {
  Step "Switching from '$branch' to dev"
  Invoke-Git checkout dev
}

# --- Is there anything to do? ----------------------------------------------
$dirty = (& $GIT status --porcelain)
$behind = (& $GIT rev-list --count "dev..$REMOTE/main").Trim()
$ahead = (& $GIT rev-list --count "$REMOTE/dev..dev").Trim()

if (-not $dirty -and $ahead -eq '0' -and $behind -eq '0') {
  Write-Host ""
  Write-Host "  Nothing to release - dev is clean, level with $REMOTE/dev, and has main." -ForegroundColor Yellow
  exit 0
}

if ($dirty -and -not $MessageText) {
  Fail "there are uncommitted changes but no commit message. Pass one:
      npm run release -- ""what changed and why"""
}

# --- Commit, then merge ----------------------------------------------------
# Commit first. `git merge` refuses to run when local edits touch a file the
# merge would bring in, so merging a dirty tree fails on exactly the days it
# matters most. Committing first makes the merge always possible, and means the
# checks below run against the fully merged tree - which is what the PR will
# actually contain, and what production will run.
if ($dirty) {
  Step "Committing"
  Invoke-Git add -A
  Invoke-Git commit -m $MessageText
} elseif ($ahead -ne '0') {
  Write-Host ""
  Write-Host "  Nothing new to commit; releasing the $ahead commit(s) already on dev." -ForegroundColor Yellow
}

Step "Merging $REMOTE/main into dev"
& $GIT merge --no-edit "$REMOTE/main"
if ($LASTEXITCODE -ne 0) {
  Fail @"
merge stopped. Resolve the conflicts, then:
      git add <files>
      git commit
      npm run release              (no message needed; the work is committed)
"@
}

# --- Verify ----------------------------------------------------------------
if ($SkipChecks) {
  Write-Host ""
  Write-Host "  Skipping typecheck and lint (-SkipChecks)." -ForegroundColor Yellow
} else {
  Step "Typecheck"
  & npm run typecheck
  if ($LASTEXITCODE -ne 0) { Fail "typecheck failed - committed locally, but NOT pushed. Fix, then re-run." }

  Step "Lint"
  & npm run lint
  if ($LASTEXITCODE -ne 0) { Fail "lint failed - committed locally, but NOT pushed. Fix, then re-run." }
}

# --- Push ------------------------------------------------------------------
Step "Pushing dev to $REMOTE"
Invoke-Git push $REMOTE dev

# --- Hand over to the PR ---------------------------------------------------
Write-Host ""
Write-Host "  Pushed. Open the PR and review the diff:" -ForegroundColor Green
Write-Host "  $COMPARE" -ForegroundColor White
Write-Host ""
Write-Host "  Then, after merging:" -ForegroundColor Green
Write-Host "    npm run release:sync                      (here)" -ForegroundColor White
Write-Host "    bash scripts/deploy.sh                    (on the droplet)" -ForegroundColor White
Write-Host ""

try { Start-Process $COMPARE } catch { }
