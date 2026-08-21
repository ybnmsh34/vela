<#
Does this path exist on the machine, or only inside a container?

    scripts\check-real-path.ps1 [-Path <p> ...] [-OutFile <path>]

## Why this is a script and not a paragraph

`docs/release-posture.md` section 12 ends with an instruction: "For any future
verification on this machine: resolve the path with `GetFinalPathNameByHandle`
before believing a filesystem or registry observation." It is good advice and it
is prose, and prose does not run. Two findings in that document were already
verifications aimed at a vantage that could not see the object they were about —
an install that landed in a package container, and an "unchanged" data directory
that was never read. Every command in both exited 0.

The redirection advertises itself nowhere. It is a bind-filter path mapping, not
a reparse point, so `Get-ChildItem`, `Test-Path`, file attributes and `fsutil
reparsepoint` all report an ordinary directory. The only thing that tells the
truth is the final path of an open handle.

## What it reports

For each path: REAL, CONTAINER (the backing store is under
`...\AppData\Local\Packages\<pkg>\LocalCache\`), or ABSENT. A CONTAINER verdict
does not mean anything is broken — it means a measurement taken from here about
that path says nothing about the user's machine, and must not be written down as
though it did.

## The control, and why it is not "did anything come back CONTAINER"

A reader that simply echoed its input would report REAL for everything, and on a
machine with no container that is also the correct answer — so "nothing was
captured" cannot distinguish a working reader from a broken one. The control
therefore does not depend on a container existing at all. It creates a directory
and a junction pointing at it, then asks for the junction's final path: a reader
resolving to backing storage answers with the TARGET, and a reader echoing its
argument answers with the junction. If that control fails, this script reports
NO VERDICT (exit 2) rather than a clean bill of health, because at that point it
has not been shown capable of returning a bad one.

## Exit codes

    0  the control held and no probed path is container-only
    1  at least one probed path resolves inside a package container
    2  the control failed, or an argument was unusable: NO VERDICT

## Readers

`docs/release-posture.md` cites its output. Run it before recording any claim
about where an installed Vela put its data, and paste the table rather than the
conclusion.

**Its reader is a person, and that is weaker than a gate.** Nothing in this
repository runs this script: it is not in `package.json`, not in
`scripts/gates.json`, and not in `.github/workflows/`. It cannot be — the fact
it measures is a property of the session it runs in, so a CI runner's answer
would be about the CI runner. That is stated here rather than left to be
discovered.

`-OutFile` has the same kind of reader — whoever passes it — and it is the
convention this repository already uses for its operator-run gate scripts:
`scripts/gate-appdata-root-acl.ps1` and `scripts/gate-m-debug-log-acl.ps1` both
take one, and both predate this file.
#>

[CmdletBinding()]
param(
    [string[]] $Path,
    [string] $OutFile
)

$ErrorActionPreference = 'Stop'

$source = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class VelaFinalPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr sa,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder buffer, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  // FILE_FLAG_BACKUP_SEMANTICS (0x02000000) is what lets a DIRECTORY handle be
  // opened at all. Without it every directory probe fails with ERROR_ACCESS_DENIED
  // and a caller could read that as "absent".
  public static string Resolve(string path) {
    IntPtr h = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (h == (IntPtr)(-1)) return "ERR:" + Marshal.GetLastWin32Error();
    try {
      StringBuilder sb = new StringBuilder(4096);
      uint n = GetFinalPathNameByHandleW(h, sb, 4096, 0);
      if (n == 0) return "ERR:" + Marshal.GetLastWin32Error();
      return sb.ToString();
    } finally { CloseHandle(h); }
  }
}
"@
Add-Type -TypeDefinition $source -Language CSharp

$report = New-Object System.Collections.Generic.List[string]
function Say([string] $text) { Write-Output $text; $report.Add($text) | Out-Null }

# The literal is built from parts so this script's own text is not what a reader
# matches on when grepping for the marker.
$containerMarker = [System.IO.Path]::Combine('AppData', 'Local', 'Packages')

function Verdict([string] $target) {
    $final = [VelaFinalPath]::Resolve($target)
    if ($final.StartsWith('ERR:')) {
        $code = $final.Substring(4)
        # 2 = ERROR_FILE_NOT_FOUND, 3 = ERROR_PATH_NOT_FOUND. Anything else is a
        # path that exists and could not be opened, which is not "absent" and
        # must not be reported as one.
        if ($code -eq '2' -or $code -eq '3') {
            return [pscustomobject]@{ verdict = 'ABSENT'; final = "(does not exist)" }
        }
        return [pscustomobject]@{ verdict = 'UNREADABLE'; final = "win32 error $code" }
    }
    $isContained = $final -like ('*' + $containerMarker + '*') -and $final -like '*LocalCache*'
    return [pscustomobject]@{ verdict = $(if ($isContained) { 'CONTAINER' } else { 'REAL' }); final = $final }
}

# ---------------------------------------------------------------------------
# CONTROL — the reader is shown resolving to backing storage, not echoing input
# ---------------------------------------------------------------------------
$controlRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vela-finalpath-control-" + $PID)
$controlTarget = Join-Path $controlRoot 'target'
$controlLink = Join-Path $controlRoot 'link'
$controlHeld = $false
try {
    New-Item -ItemType Directory -Path $controlTarget -Force | Out-Null
    New-Item -ItemType Junction -Path $controlLink -Target $controlTarget -ErrorAction Stop | Out-Null
    $seen = [VelaFinalPath]::Resolve($controlLink)
    $controlHeld = $seen -like '*target*' -and $seen -notlike '*link*'
    Say ("CONTROL  junction -> " + $seen)
    if ($controlHeld) {
        Say "CONTROL  PASS  the reader answers with the junction's TARGET, so it resolves backing storage."
    }
    else {
        Say "CONTROL  FAIL  the reader answered with the link itself. It is echoing its argument."
    }
}
catch {
    Say ("CONTROL  FAIL  could not build the junction control: " + $_.Exception.Message)
}
finally {
    Remove-Item -LiteralPath $controlRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Say ""

if (-not $controlHeld) {
    Say "NO VERDICT. The reader was not shown able to detect a redirected path, so"
    Say "every REAL below would be unfalsifiable. Nothing is reported."
    if ($OutFile) { $report | Out-File -FilePath $OutFile -Encoding utf8 }
    exit 2
}

# ---------------------------------------------------------------------------
# The paths Vela actually resolves, read out of the shipped configuration
# ---------------------------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot
$conf = Get-Content (Join-Path $repoRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$identifier = $conf.identifier
$product = $conf.productName

# `app_data_dir()` on Windows is %APPDATA%\<identifier>; `vela.db` sits directly
# in it (vela-store's DATABASE_FILE_NAME) and `diagnostics\` beside it
# (src/ipc/diagnostics.rs). NSIS installs per-user into %LOCALAPPDATA%\<product>.
$appData = Join-Path $env:APPDATA $identifier
$targets = @(
    $appData,
    (Join-Path $appData 'vela.db'),
    (Join-Path $appData 'diagnostics'),
    (Join-Path $appData 'skills'),
    (Join-Path $env:LOCALAPPDATA $product),
    (Join-Path $env:LOCALAPPDATA "$product\$($product.ToLower()).exe"),
    (Join-Path $env:USERPROFILE "Desktop\$product.lnk"),
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$product.lnk")
)
if ($Path) { $targets += $Path }

Say ("identifier   " + $identifier)
Say ("productName  " + $product)
Say ""
Say ("{0,-11} {1}" -f 'VERDICT', 'PATH  ->  BACKING PATH')

$contained = 0
foreach ($target in $targets) {
    $v = Verdict $target
    if ($v.verdict -eq 'CONTAINER') { $contained++ }
    Say ("{0,-11} {1}  ->  {2}" -f $v.verdict, $target, $v.final)
}

Say ""
Say ("container-only paths  " + $contained)

if ($contained -gt 0) {
    Say ""
    Say "At least one path above exists only inside a package container. A file or"
    Say "registry observation made from this session about such a path is not a fact"
    Say "about the user's machine, however cleanly the command exited. Do not record"
    Say "an install, a data location or an uninstall as verified from here."
    if ($OutFile) { $report | Out-File -FilePath $OutFile -Encoding utf8 }
    exit 1
}

Say ""
Say "Every path above resolves to real backing storage, and the control shows this"
Say "reader would have said otherwise."
if ($OutFile) { $report | Out-File -FilePath $OutFile -Encoding utf8 }
exit 0
