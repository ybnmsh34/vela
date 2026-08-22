<#
GATE M — the debug log's ACL, measured FROM A SHELL on a real Windows machine.

    scripts\gate-m-debug-log-acl.ps1 [-OutFile <path>] [-DataDir <path>]

## What this measures that the unit tests do not

`vela-privatefs/src/lib.rs` and `src-tauri/src/ipc/diagnostics.rs` assert
"nobody foreign can reach this path" from inside the process that created it,
reading the ACL back through the same `GetNamedSecurityInfoW` call the code
under test used, in a temporary directory. That is a good assertion and a poor
measurement: it shares a process and a reader with the thing it is checking, and
it never touches the directory the finding was actually about.

This drives the real `debug_log_set` against the **real application-data
directory** (`gate_m_debug_log_acl.rs`, which is `#[ignore]`d precisely so it is
only ever run from here), then closes the process and asks `Get-Acl` — the same
tool a user, or an auditor, would reach for.

## The state it starts from

`icacls <dir> /reset` restores the directory to exactly the pre-fix condition:
inheritance enabled, every ACE the parent hands down present. On the machine
this gate was written for, that is:

    DESKTOP-298M5DU\User               FullControl                 inherited=True
    NT AUTHORITY\SYSTEM                FullControl                 inherited=True
    BUILTIN\Administrators             FullControl                 inherited=True
    DESKTOP-298M5DU\CodexSandboxUsers  ReadAndExecute, Synchronize inherited=True
    S-1-15-3-3557520199-...            FullControl                 inherited=True

A separate local group reading the directory that holds raw provider exchanges.
Resetting first is what makes BEFORE a measurement rather than a screenshot of
whatever the last run left behind.

## The control

A check that cannot come back wrong proves nothing. The last section widens a
scratch directory with the identical `icacls` grant and reads it through the
identical `Get-Acl` call, so the reader is shown reporting a foreign principal
on a directory that genuinely has one.

Exit code 0 iff every check passes.
#>

[CmdletBinding()]
param(
    [string] $OutFile,
    [string] $DataDir
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$appId = (Get-Content (Join-Path $repoRoot 'src-tauri\tauri.conf.json') -Raw |
    ConvertFrom-Json).identifier

if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA $appId }
$diagnostics = Join-Path $DataDir 'diagnostics'
$logFile = Join-Path $diagnostics 'exchanges.jsonl'

$report = New-Object System.Collections.Generic.List[string]
$script:failures = 0

function Say([string] $text) {
    Write-Host $text
    $report.Add($text) | Out-Null
}

function Check([string] $claim, [bool] $ok, [string] $got) {
    if ($ok) { Say "PASS  $claim  (got $got)" }
    else { Say "FAIL  $claim  (got $got)"; $script:failures++ }
}

# Every principal on the DACL that is neither the running account nor SYSTEM.
# The same quantity `private_fs::Privacy::foreign` holds, computed independently
# by PowerShell so the two readers can disagree.
function Foreign-Principals([string] $path) {
    $acl = Get-Acl -LiteralPath $path
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $system = 'S-1-5-18'
    $out = @()
    foreach ($ace in $acl.Access) {
        if ($ace.AccessControlType -ne 'Allow') { continue }
        $sid = $ace.IdentityReference
        if ($sid -isnot [System.Security.Principal.SecurityIdentifier]) {
            $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
        }
        if ($sid.Value -eq $me -or $sid.Value -eq $system) { continue }
        $out += "$($ace.IdentityReference) [$($sid.Value)] $($ace.FileSystemRights)"
    }
    return , $out
}

# Windows PowerShell 5.1 mis-parses a `$(if (...) { ... -join ... })` inside a
# double-quoted string, so this stays a plain function call.
function Principals([string[]] $found) {
    if ($found.Count -eq 0) { return '<none>' }
    return [string]::Join('  |  ', $found)
}

function Show-Acl([string] $label, [string] $path) {
    if (-not (Test-Path -LiteralPath $path)) { Say "$label  <absent> $path"; return }
    $acl = Get-Acl -LiteralPath $path
    Say "$label  path                : $path"
    Say "$label  Owner               : $($acl.Owner)"
    Say "$label  Inheritance enabled : $(-not $acl.AreAccessRulesProtected)"
    foreach ($ace in $acl.Access) {
        Say ("$label    {0,-42} {1,-28} inherited={2}" -f `
                $ace.IdentityReference, $ace.FileSystemRights, $ace.IsInherited)
    }
    Say "$label  SDDL                : $($acl.Sddl)"
}

Say "identifier            $appId"
Say "data directory        $DataDir"
Say "diagnostics directory $diagnostics"
Say ""

# ---------------------------------------------------------------------------
# BEFORE — the pre-fix state, restored on purpose
# ---------------------------------------------------------------------------

Say "== BEFORE — inheritance restored, i.e. the state that shipped =="
if (-not (Test-Path -LiteralPath $diagnostics)) {
    # `create_dir_all`, which is exactly what the pre-fix Windows branch did.
    New-Item -ItemType Directory -Path $diagnostics -Force | Out-Null
}
& icacls $diagnostics /reset | Out-Null
if (Test-Path -LiteralPath $logFile) { & icacls $logFile /reset | Out-Null }
Show-Acl 'BEFORE' $diagnostics

$beforeForeign = Foreign-Principals $diagnostics
Say ('BEFORE  foreign principals  : ' + (Principals $beforeForeign))
Say ''

if ($beforeForeign.Count -eq 0) {
    Say 'NOTE  this machine hands down no foreign ACE under the application-data'
    Say '      directory, so BEFORE is already clean here. The AFTER checks still'
    Say '      stand; the control at the end is what proves the reader is able to'
    Say '      report a foreign principal at all.'
    Say ''
}

# ---------------------------------------------------------------------------
# The real switch, in a real process
# ---------------------------------------------------------------------------

Say "== DRIVE — the real debug_log_set, then the process exits =="
Push-Location (Join-Path $repoRoot 'src-tauri')
try {
    $env:VELA_GATE_DEBUG_LOG_DATA_DIR = $DataDir
    $driver = & cargo test --quiet --test gate_m_debug_log_acl -- `
        --ignored --exact --nocapture debug_log_acl_evidence_driver 2>&1
    $driverExit = $LASTEXITCODE
    $drove = $driverExit -eq 0
}
finally {
    Remove-Item Env:\VELA_GATE_DEBUG_LOG_DATA_DIR -ErrorAction SilentlyContinue
    Pop-Location
}
foreach ($line in $driver) { Say ('      ' + $line) }
Check 'the evidence driver completed' $drove ('cargo exit ' + $driverExit)
Say ''

# ---------------------------------------------------------------------------
# AFTER — read back by Get-Acl, not by the code that wrote it
# ---------------------------------------------------------------------------

Say "== AFTER — the same directory, read by Get-Acl =="
Show-Acl 'AFTER-DIR' $diagnostics
Say ""
Show-Acl 'AFTER-LOG' $logFile
Say ""

$afterForeign = Foreign-Principals $diagnostics
$afterProtected = (Get-Acl -LiteralPath $diagnostics).AreAccessRulesProtected
Say ('AFTER   foreign principals  : ' + (Principals $afterForeign))
Check 'no principal but the owner and SYSTEM can reach the diagnostics directory' ($afterForeign.Count -eq 0) ("" + $afterForeign.Count + ' foreign')
Check 'the diagnostics DACL is protected from inheritance' ($afterProtected) ("AreAccessRulesProtected=" + $afterProtected)

if (Test-Path -LiteralPath $logFile) {
    $logForeign = Foreign-Principals $logFile
    $logProtected = (Get-Acl -LiteralPath $logFile).AreAccessRulesProtected
    Say ('AFTER   log foreign          : ' + (Principals $logForeign))
    Check 'no principal but the owner and SYSTEM can read the debug log itself' ($logForeign.Count -eq 0) ("" + $logForeign.Count + ' foreign')
    Check 'the debug log DACL is protected from inheritance' ($logProtected) ("AreAccessRulesProtected=" + $logProtected)
}
else {
    Say 'FAIL  the log file was never created, so its ACL was not measured'
    $script:failures++
}
Say ''

# ---------------------------------------------------------------------------
# CONTROL — the reader, shown failing
# ---------------------------------------------------------------------------

Say "== CONTROL — the same reader, on a deliberately widened directory =="
$control = Join-Path ([System.IO.Path]::GetTempPath()) "vela-acl-control-$PID"
New-Item -ItemType Directory -Path $control -Force | Out-Null
try {
    # `BUILTIN\Users` — not the owner, not SYSTEM, present on every install.
    & icacls $control /grant '*S-1-5-32-545:(OI)(CI)(RX)' | Out-Null
    $controlForeign = Foreign-Principals $control
    Say ('CONTROL foreign principals  : ' + (Principals $controlForeign))
    Check 'the reader reports a foreign principal on a directory that has one' ($controlForeign.Count -gt 0) ("" + $controlForeign.Count + ' foreign')
}
finally {
    Remove-Item -LiteralPath $control -Recurse -Force -ErrorAction SilentlyContinue
}

Say ""
Say "failures              $script:failures"

if ($OutFile) { $report | Out-File -FilePath $OutFile -Encoding utf8 }
if ($script:failures -ne 0) { exit 1 }
exit 0
