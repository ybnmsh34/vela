<#
GATE — the application-data root's ACL, measured FROM A SHELL on a real Windows
machine.

    scripts\gate-appdata-root-acl.ps1 [-OutFile <path>] [-ScratchDir <path>]

## What this measures that the unit tests do not

`vela-store/src/location.rs` asserts "nobody foreign can reach this directory"
from inside the process that hardened it, reading the ACL back through the same
`GetNamedSecurityInfoW` call the code under test used. That is a good assertion
and a poor measurement: it shares a process and a reader with the thing it is
checking.

This opens a real `SqliteStore` (`gate_appdata_root_acl.rs`, `#[ignore]`d
precisely so it is only ever run from here), writes a real conversation so
SQLite produces a real `-wal`, closes the process, and then asks `Get-Acl` — the
same tool a user, or an auditor, would reach for.

## It runs against a SCRATCH directory, never the user's

The finding was on `%APPDATA%\dev.vela.desktop`, which holds live conversations.
What is under test is the *transition* from a widened directory to a private
one, and a scratch directory widened with the identical `icacls` grant
reproduces that exactly. Pointing an automated ACL rewrite at a live database to
prove it is safe is not a trade worth making, so this script creates its own
directory under %TEMP% and never reads or writes the real one.

## The state it starts from

The scratch directory is created and then **deliberately widened** with the same
grant the audit found inherited on the real one:

    <group>:(OI)(CI)(RX)

with `<group>` preferring the local `CodexSandboxUsers` — the literal principal
from the finding — and falling back to `BUILTIN\Users` (S-1-5-32-545) on a
machine that has no such group. Widening first is what makes BEFORE a
measurement rather than a screenshot of an already-clean directory.

## The control

A check that cannot come back wrong proves nothing. The last section widens a
second scratch directory with the identical grant, leaves it alone, and reads it
through the identical `Get-Acl` call — so the reader is shown reporting
`AreAccessRulesProtected: False` and a foreign principal on a directory that
genuinely has one.

Exit code 0 iff every check passes.
#>

[CmdletBinding()]
param(
  [string]$OutFile,
  [string]$ScratchDir = (Join-Path $env:TEMP ("vela-gate-appdata-" + [guid]::NewGuid().ToString('N').Substring(0,8)))
)

$ErrorActionPreference = 'Stop'
$script:Failures = @()

# `[Console]::WriteLine` rather than `Write-Output`, deliberately. `Write-Output`
# puts the line on the *pipeline*, so every `Say` inside a function silently
# becomes part of that function's return value — which is how `Show-Acl` came to
# return an array of log lines instead of an ACL, and how two checks below came
# to pass on paths that did not exist. A logger must not be able to do that.
function Say([string]$Text) {
  [Console]::WriteLine($Text)
  if ($OutFile) { Add-Content -Path $OutFile -Value $Text -Encoding utf8 }
}

# Setup that cannot proceed. Reports into the transcript and leaves with a
# failing status, rather than throwing and taking the transcript with it -- the
# same reason the database check below is guarded.
function Bail([string]$Why) {
  Say ""
  Say "  SETUP FAILED  $Why"
  Say "=============================================================="
  Say " GATE COULD NOT RUN"
  exit 1
}

function Check([string]$What, [bool]$Ok) {
  if ($Ok) { Say "  PASS  $What" } else { Say "  FAIL  $What"; $script:Failures += $What }
}

# The principal to widen with: the one the finding actually named, if it is on
# this machine, otherwise a group that exists on every installation.
function Resolve-ForeignGroup {
  $name = "$env:COMPUTERNAME\CodexSandboxUsers"
  try {
    $null = (New-Object System.Security.Principal.NTAccount($name)).Translate(
      [System.Security.Principal.SecurityIdentifier])
    return $name
  } catch {
    return '*S-1-5-32-545'
  }
}

function Show-Acl([string]$Label, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { Say "$Label  $Path  <absent>"; return $null }
  $acl = Get-Acl -LiteralPath $Path
  Say "$Label  $Path"
  Say ("    Owner                   : " + $acl.Owner)
  Say ("    AreAccessRulesProtected : " + $acl.AreAccessRulesProtected)
  foreach ($ace in $acl.Access) {
    Say ("      {0,-42} {1,-30} inherited={2}" -f `
      $ace.IdentityReference, $ace.FileSystemRights, $ace.IsInherited)
  }
  Say ("    SDDL                    : " + $acl.Sddl)
  return $acl
}

# Every principal in the DACL that is neither the directory's owner nor SYSTEM
# nor Administrators-by-ownership. The shell's own answer to the question
# `private_fs::describe` answers in process.
function Foreign-Principals($Acl) {
  if ($null -eq $Acl) { return @() }
  $mine = @($Acl.Owner, 'NT AUTHORITY\SYSTEM')
  @($Acl.Access |
    Where-Object { $_.AccessControlType -eq 'Allow' } |
    ForEach-Object { $_.IdentityReference.Value } |
    Where-Object { $mine -notcontains $_ } |
    Select-Object -Unique)
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$srcTauri = Join-Path $repoRoot 'src-tauri'
$group = Resolve-ForeignGroup

if ($OutFile -and (Test-Path -LiteralPath $OutFile)) { Remove-Item -LiteralPath $OutFile -Force }

Say "=============================================================="
Say " GATE — application-data root ACL"
Say " scratch  : $ScratchDir"
Say " widen as : $group"
Say " machine  : $env:COMPUTERNAME   user: $env:USERNAME"
Say " when     : $(Get-Date -Format o)"
Say "=============================================================="
Say ""
Say "NOTE: this gate never touches $env:APPDATA\dev.vela.desktop."
Say ""

# ---------------------------------------------------------------------------
# 1. A scratch directory in exactly the state the audit found the real one in.
# ---------------------------------------------------------------------------
Say "--- 1. BEFORE: a widened directory with a database already in it --------"
New-Item -ItemType Directory -Force -Path $ScratchDir | Out-Null
# An existing installation: entries that predate the fix, which the hardening
# has to repair rather than merely coexist with.
$skills = Join-Path $ScratchDir 'skills'
New-Item -ItemType Directory -Force -Path $skills | Out-Null
$null = & icacls $ScratchDir /grant "${group}:(OI)(CI)(RX)"
if ($LASTEXITCODE -ne 0) { Bail "icacls could not widen $ScratchDir with $group" }

# And the shape protecting the root does NOT reach: an ACE the child carries
# EXPLICITLY. Hardening a parent rewrites only the inherited portion of a
# child's DACL, so this one survives unless something walks for it. The file is
# created afterwards so it is born carrying the ACE by inheritance — the
# propagation half, not just the directory half.
#
# Granted to a DIFFERENT principal from the root, and that is the whole point.
# The root is widened with the group from the finding, which %TEMP% on this
# machine ALREADY hands down — so "skills/ has a foreign principal" is
# ambient-true and a check asserting only that cannot come back wrong. It
# passed with the inheritance flags stripped. `BUILTIN\Users` appears nowhere
# else in this tree, so every assertion about it below is provably this gate's
# own doing.
$childSid = 'S-1-5-32-545'
$childGroup = (New-Object System.Security.Principal.SecurityIdentifier($childSid)).Translate(
  [System.Security.Principal.NTAccount]).Value

# The precondition that makes the precondition meaningful.
$preexisting = @((Get-Acl -LiteralPath $skills).Access |
  Where-Object { $_.IdentityReference.Value -eq $childGroup })
if ($preexisting.Count -gt 0) {
  throw "$childGroup already reaches $skills before this gate granted anything; pick another principal"
}

$null = & icacls $skills /grant "*${childSid}:(OI)(CI)(RX)"
if ($LASTEXITCODE -ne 0) { Bail "icacls could not widen $skills with $childGroup" }
Set-Content -Path (Join-Path $skills 'my-skill.md') -Value "---`nname: my-skill`n---" -Encoding utf8

$before = Show-Acl 'BEFORE  ' $ScratchDir
$beforeForeign = Foreign-Principals $before
Say ""
Check "BEFORE names at least one foreign principal (else the test proves nothing)" ($beforeForeign.Count -gt 0)
Check "BEFORE has inheritance enabled, as the real directory did" (-not $before.AreAccessRulesProtected)

# %TEMP% on this machine already inherits CodexSandboxUsers, so "a foreign
# principal is present" would be true even if this gate granted nothing at all —
# a check that cannot come back wrong. What IS this gate's own doing is the
# NON-INHERITED ace it just granted, so that is what gets asserted: blind the
# `icacls` above and this fails, which is the property a control needs.
$deliberate = @($before.Access | Where-Object {
  -not $_.IsInherited -and $_.AccessControlType -eq 'Allow' -and
  $_.IdentityReference.Value -ne $before.Owner
})
Check "BEFORE carries the gate's OWN explicit grant, not just what %TEMP% hands down" ($deliberate.Count -gt 0)
Say "  BEFORE foreign: $($beforeForeign -join ', ')"
Say "  BEFORE explicit (this gate's doing): $(@($deliberate | ForEach-Object { $_.IdentityReference.Value }) -join ', ')"

$beforeSkills = Show-Acl 'BEFORE  ' $skills
Check "BEFORE skills/ carries $childGroup as a NON-INHERITED ace (the shape inheritance cannot fix)" (
  @($beforeSkills.Access | Where-Object {
    -not $_.IsInherited -and $_.IdentityReference.Value -eq $childGroup }).Count -gt 0)

# Named principal, not a count. `Count -gt 0` here was ambient-true: strip the
# (OI)(CI) flags so the file inherits nothing from skills/ and it still passed,
# while claiming to establish the propagation half. Nothing but skills/ grants
# $childGroup, so its presence on the file can only have come from skills/.
$beforeSkillFile = Show-Acl 'BEFORE  ' (Join-Path $skills 'my-skill.md')
Check "BEFORE skills/my-skill.md inherited $childGroup FROM skills/" (
  @($beforeSkillFile.Access | Where-Object {
    $_.IsInherited -and $_.IdentityReference.Value -eq $childGroup }).Count -gt 0)
Say ""

# ---------------------------------------------------------------------------
# 2. The real code, in its own process.
# ---------------------------------------------------------------------------
Say "--- 2. Driving the real SqliteStore::open ------------------------------"
$env:VELA_GATE_APPDATA_ROOT_DIR = $ScratchDir
Push-Location $srcTauri
try {
  # `2>&1` on a native command wraps every stderr line in an ErrorRecord, and
  # Windows PowerShell turns that into a throw while `$ErrorActionPreference`
  # is `Stop`. Cargo writes its whole progress log to stderr, so without this
  # the gate aborts the moment cargo says anything at all.
  $ErrorActionPreference = 'Continue'
  $driver = & cargo test --test gate_appdata_root_acl -- --ignored --nocapture 2>&1 |
    ForEach-Object { $_.ToString() }
  $driverExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = 'Stop'
  Pop-Location
  Remove-Item Env:\VELA_GATE_APPDATA_ROOT_DIR -ErrorAction SilentlyContinue
}
foreach ($line in $driver) { Say "  | $line" }
Check "the evidence driver passed" ($driverExit -eq 0)
Say ""

# ---------------------------------------------------------------------------
# 3. AFTER, read by a tool that shares no code with the fix.
# ---------------------------------------------------------------------------
Say "--- 3. AFTER: Get-Acl, independently ----------------------------------"
$after = Show-Acl 'AFTER   ' $ScratchDir
$afterForeign = Foreign-Principals $after
Say ""
Check "AFTER has inheritance DISABLED (AreAccessRulesProtected: True)" ([bool]$after.AreAccessRulesProtected)
Check "AFTER names no foreign principal" ($afterForeign.Count -eq 0)
if ($afterForeign.Count -gt 0) { Say "  AFTER foreign: $($afterForeign -join ', ')" }
$survivors = @($beforeForeign | Where-Object { $afterForeign -contains $_ })
Check "every principal that could reach it BEFORE is gone" ($survivors.Count -eq 0)
if ($survivors.Count -gt 0) { Say "  survived: $($survivors -join ', ')" }
Say ""

Say "--- 3b. AFTER: the database, and a directory created after hardening ---"
# `vela-projects` creates `projects/` with a plain `create_dir_all`, after
# `SqliteStore::open` has run. Creating it here, from a shell, with no ACL
# argument of any kind, is the least generous possible version of that: if it
# comes out private it is because it inherited, and for no other reason.
New-Item -ItemType Directory -Force -Path (Join-Path $ScratchDir 'projects') | Out-Null

foreach ($child in @('vela.db', 'skills', 'skills\my-skill.md', 'projects')) {
  $path = Join-Path $ScratchDir $child
  $acl = Show-Acl "AFTER   " $path
  if ($null -eq $acl) {
    Check "$child exists to be measured" $false
  } else {
    $f = Foreign-Principals $acl
    Check "$child is reachable by no foreign principal" ($f.Count -eq 0)
    if ($f.Count -gt 0) { Say "    foreign: $($f -join ', ')" }
    # Named, as well as counted: the explicit grant this gate made itself is
    # the one protecting the root provably cannot remove.
    if ($child -like 'skills*') {
      Check "$child no longer carries $childGroup" (
        @($acl.Access | Where-Object { $_.IdentityReference.Value -eq $childGroup }).Count -eq 0)
    }
  }
  Say ""
}

# The `-wal` and `-shm` are gone by now: SQLite checkpoints and removes them on
# a clean close, which the driver performs before this shell resumes. They are
# therefore NOT measurable from here, and reporting a PASS on an absent file
# would be a check that cannot come back wrong. What is measurable is that the
# driver read them *while they existed* and found nobody foreign — so that is
# what is asserted, against the driver's own transcript.
Say "--- 3c. The WAL and SHM, measured in-process while they existed -------"
foreach ($sibling in @('AFTER-FILE-wal', 'AFTER-FILE-shm')) {
  $seen = @($driver | Where-Object { $_ -match "^$sibling foreign=" })
  Check "$sibling was measured by the driver" ($seen.Count -gt 0)
  foreach ($line in $seen) { Say "    $line" }
  Check "$sibling named no foreign principal" (
    $seen.Count -gt 0 -and @($seen | Where-Object { $_ -notmatch 'foreign=<none>$' }).Count -eq 0)
}
foreach ($name in @('vela.db-wal', 'vela.db-shm')) {
  $p = Join-Path $ScratchDir $name
  if (Test-Path -LiteralPath $p) { Say "  NOTE  $name still on disk; shell-side ACL:"; $null = Show-Acl "        " $p }
  else { Say "  NOTE  $name absent — SQLite removed it on clean close, as expected" }
}
Say ""

# Guarded rather than bare. `Get-Item` on a missing path throws, and with
# `$ErrorActionPreference = 'Stop'` a throw kills the script — so blinding the
# hardening used to make the gate *die* instead of reporting which check failed.
# A gate that cannot say what went wrong is only half a gate.
$database = Join-Path $ScratchDir 'vela.db'
$databaseBytes = if (Test-Path -LiteralPath $database) { (Get-Item -LiteralPath $database).Length } else { -1 }
Check "the database survived the hardening with its bytes intact" ($databaseBytes -gt 0)
if ($databaseBytes -le 0) { Say "  vela.db is absent or empty (length reported: $databaseBytes)" }
Say ""

# ---------------------------------------------------------------------------
# 4. The control. The reader must be able to come back wrong.
# ---------------------------------------------------------------------------
Say "--- 4. CONTROL: the same reader on a directory nobody hardened ---------"
$control = Join-Path $env:TEMP ("vela-gate-control-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $control | Out-Null
$null = & icacls $control /grant "${group}:(OI)(CI)(RX)"
$controlAcl = Show-Acl 'CONTROL ' $control
$controlForeign = Foreign-Principals $controlAcl
Say ""
Check "CONTROL reports inheritance enabled" (-not $controlAcl.AreAccessRulesProtected)
Check "CONTROL reports a foreign principal, so a clean AFTER means something" ($controlForeign.Count -gt 0)
Say "  CONTROL foreign: $($controlForeign -join ', ')"
Say ""

Remove-Item -LiteralPath $control -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ScratchDir -Recurse -Force -ErrorAction SilentlyContinue

Say "=============================================================="
if ($script:Failures.Count -eq 0) {
  Say " GATE PASSED"
  exit 0
} else {
  Say " GATE FAILED — $($script:Failures.Count) check(s):"
  foreach ($f in $script:Failures) { Say "   - $f" }
  exit 1
}
