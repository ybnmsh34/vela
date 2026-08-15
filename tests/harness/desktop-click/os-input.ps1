<#
.SYNOPSIS
  Win32 input for the click harness: raise a window, prove whether injected
  input works at all, and deliver a click by one of two named mechanisms.

.DESCRIPTION
  There are three different things people mean by "a real click", and this
  script keeps them apart because a verdict that conflates them is worthless.

    -Mode selftest    Does `SendInput` do anything in this process at all?
                      Moves the cursor with SetCursorPos, then asks SendInput to
                      move it somewhere else, then reads the cursor back. If it
                      did not move, injected input is being filtered and every
                      `sendinput` click below would report success and deliver
                      nothing. Measured, not assumed.

    -Mode sendinput   The real thing: MOUSEEVENTF_LEFTDOWN/LEFTUP into the
                      system input queue. Windows decides which window receives
                      it. This is what a user's mouse does.

    -Mode message     PostMessage WM_LBUTTONDOWN/WM_LBUTTONUP to the window
                      under the point. The message goes through the target
                      window's own message loop and Chromium hit-tests the client
                      coordinates exactly as it does for a user click — but the
                      *window* was chosen by this script rather than by the input
                      stack, and the message never entered the system input
                      queue. It is a Win32 message, not OS input. Say so.

    -Mode raise       Bring the window forward and report its rectangle.

  **The ownership guard.** A real click goes wherever the cursor is. An early
  run of this harness raised nothing, landed on a Chrome window that happened to
  be in front, and reported honestly that nothing had reached Vela — after
  having already clicked inside somebody else's application. So both delivery
  modes now ask `WindowFromPoint` who owns the target pixel and refuse unless
  the answer is `-RequirePid` or a descendant of it. WebView2 hosts content in a
  child window owned by `msedgewebview2.exe`, a child of the app, which is why
  the test is ancestry rather than equality.

  The cursor is restored to where it was found.
#>
[CmdletBinding()]
param(
  [int]$X = 0,
  [int]$Y = 0,
  [int]$OwnerPid = 0,
  [int]$RequirePid = 0,
  [ValidateSet('raise', 'selftest', 'sendinput', 'message')]
  [string]$Mode = 'raise'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class VelaOsInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx; public int dy; public uint mouseData;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    // The INPUT union is as wide as its widest member; MOUSEINPUT is wider than
    // KEYBDINPUT and HARDWAREINPUT on both x86 and x64, so declaring it alone
    // gives the 40-byte size SendInput expects on x64.
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public MOUSEINPUT mi; }

    public const uint INPUT_MOUSE = 0;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const byte VK_MENU = 0x12;

    public const uint WM_MOUSEMOVE = 0x0200;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public const int MK_LBUTTON = 0x0001;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    public static string TitleOf(IntPtr hWnd)
    {
        StringBuilder builder = new StringBuilder(512);
        GetWindowTextW(hWnd, builder, builder.Capacity);
        return builder.ToString();
    }

    /// Every top-level window of the process, with what is needed to choose
    /// between them. Two lessons are baked in.
    ///
    /// A WebView2/tao host owns several — a 16x16 untitled `WS_POPUP` helper at
    /// (0,0) among them — so "the first one" is the wrong answer, and taking it
    /// left this harness raising that helper while the real window stayed
    /// behind another application.
    ///
    /// And **invisible windows are included on purpose**. The Vela window was
    /// observed with `WS_VISIBLE` cleared while its webview was still answering
    /// CDP perfectly: `style=0x04CF0000`, title "Vela", rect (690,306)-(1886,1095),
    /// `IsWindowVisible` false. Filtering on visibility hid the only window that
    /// mattered and left nothing but the helper. The caller shows it instead,
    /// and says that it had to.
    public static List<object[]> TopLevelWindowsOf(uint targetPid)
    {
        List<object[]> found = new List<object[]>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid != targetPid) { return true; }
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) { return true; }
            long area = (long)(rect.Right - rect.Left) * (long)(rect.Bottom - rect.Top);
            if (area <= 0) { return true; }
            found.Add(new object[] {
                hWnd, TitleOf(hWnd), area, IsWindowVisible(hWnd),
                rect.Left, rect.Top, rect.Right, rect.Bottom
            });
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /// Foreground activation is refused across processes unless the caller owns
    /// the foreground. Three documented workarounds are applied together,
    /// because any one of them fails on its own often enough to matter: a
    /// synthetic ALT tap, attaching this thread's input queue to both the
    /// current foreground thread and the target's, and
    /// BringWindowToTop/SetActiveWindow inside that attachment. All undone after.
    public static bool Raise(IntPtr hWnd)
    {
        if (IsIconic(hWnd)) { ShowWindow(hWnd, 9 /* SW_RESTORE */); }
        if (GetForegroundWindow() == hWnd) { return true; }

        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);

        IntPtr foreground = GetForegroundWindow();
        uint foregroundPid;
        uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
        uint targetPid;
        uint targetThread = GetWindowThreadProcessId(hWnd, out targetPid);
        uint thisThread = GetCurrentThreadId();

        AllowSetForegroundWindow(-1 /* ASFW_ANY */);
        bool attachedForeground = AttachThreadInput(thisThread, foregroundThread, true);
        bool attachedTarget = (targetThread != thisThread) && AttachThreadInput(thisThread, targetThread, true);

        ShowWindow(hWnd, 5 /* SW_SHOW */);
        BringWindowToTop(hWnd);
        SetActiveWindow(hWnd);
        bool ok = SetForegroundWindow(hWnd);

        if (attachedTarget) { AttachThreadInput(thisThread, targetThread, false); }
        if (attachedForeground) { AttachThreadInput(thisThread, foregroundThread, false); }

        return ok && GetForegroundWindow() == hWnd;
    }
}
'@

# Without this the cursor coordinates below are interpreted in the shell's own
# (possibly virtualised) DPI space, which silently offsets every click on a
# scaled display.
[void][VelaOsInput]::SetProcessDPIAware()

# NOT named $pid: that is an automatic read-only variable in PowerShell and
# binding a parameter to it fails at call time, not at parse time.
function Get-Ancestry([int]$startPid) {
  $chain = @()
  $current = $startPid
  $seen = @{}
  for ($i = 0; $i -lt 12; $i++) {
    if ($seen.ContainsKey($current)) { break }
    $seen[$current] = $true
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
    if (-not $proc) { break }
    $chain += [pscustomobject]@{ pid = [int]$proc.ProcessId; name = $proc.Name }
    $current = [int]$proc.ParentProcessId
    if ($current -le 0) { break }
  }
  return $chain
}

$report = [ordered]@{
  mode                   = $Mode
  requested              = [ordered]@{ x = $X; y = $Y }
  ownerPid               = $OwnerPid
  requirePid             = $RequirePid
  raised                 = $false
  window                 = $null
  candidateWindows       = @()
  cursorBefore           = $null
  cursorAtClick          = $null
  hwndUnderPoint         = $null
  hwndUnderPointPid      = $null
  hwndUnderPointAncestry = @()
  ownsTargetPixel        = $null
  blocked                = $false
  blockedReason          = $null
  delivered              = $false
  sendInputSelfTest      = $null
  detail                 = $null
  error                  = $null
}

$before = New-Object VelaOsInput+POINT
[void][VelaOsInput]::GetCursorPos([ref]$before)
$report.cursorBefore = [ordered]@{ x = $before.X; y = $before.Y }

try {
  if ($OwnerPid -gt 0) {
    # Titled first, then largest. Both keys are needed and both are reported:
    # the helper window is untitled AND tiny, and sorting on either one alone
    # has picked it before.
    $candidates = [VelaOsInput]::TopLevelWindowsOf([uint32]$OwnerPid) | ForEach-Object {
      [pscustomobject]@{
        handle  = [int64]$_[0]
        hwnd    = [IntPtr]$_[0]
        title   = [string]$_[1]
        area    = [int64]$_[2]
        visible = [bool]$_[3]
        rect    = [ordered]@{ left = $_[4]; top = $_[5]; right = $_[6]; bottom = $_[7] }
      }
    }
    $report.candidateWindows = @($candidates | ForEach-Object {
      [ordered]@{ handle = $_.handle; title = $_.title; area = $_.area; visible = $_.visible; rect = $_.rect }
    })
    # Titled first, then largest. Both keys are needed and both are reported:
    # the helper window is untitled AND tiny, and sorting on either alone has
    # picked it before.
    $chosen = @($candidates | Sort-Object -Property @{ Expression = { $_.title.Length -gt 0 }; Descending = $true },
                                                    @{ Expression = { $_.area }; Descending = $true }) |
              Select-Object -First 1
    if ($chosen) {
      $wasHidden = -not $chosen.visible
      if ($wasHidden) { [void][VelaOsInput]::ShowWindow($chosen.hwnd, 5) }  # SW_SHOW
      $report.raised = [VelaOsInput]::Raise($chosen.hwnd)
      Start-Sleep -Milliseconds 250
      $rect = New-Object VelaOsInput+RECT
      [void][VelaOsInput]::GetWindowRect($chosen.hwnd, [ref]$rect)
      $report.window = [ordered]@{
        handle    = $chosen.handle
        title     = $chosen.title
        rect      = [ordered]@{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
        minimised = [VelaOsInput]::IsIconic($chosen.hwnd)
        wasHidden = $wasHidden
        visibleNow = [VelaOsInput]::IsWindowVisible($chosen.hwnd)
      }
    } else {
      $report.error = "no top-level window with a non-zero rectangle for pid $OwnerPid"
    }
  }

  if ($Mode -eq 'raise') {
    $report | ConvertTo-Json -Compress -Depth 6
    exit 0
  }

  if ($Mode -eq 'selftest') {
    # Park the cursor somewhere known with SetCursorPos (which is not injection),
    # then ask SendInput to move it a measurable distance, and read it back.
    $anchorX = 200
    $anchorY = 200
    [void][VelaOsInput]::SetCursorPos($anchorX, $anchorY)
    Start-Sleep -Milliseconds 80
    $parked = New-Object VelaOsInput+POINT
    [void][VelaOsInput]::GetCursorPos([ref]$parked)

    $move = New-Object VelaOsInput+INPUT
    $move.type = [VelaOsInput]::INPUT_MOUSE
    $move.mi.dwFlags = [VelaOsInput]::MOUSEEVENTF_MOVE -bor [VelaOsInput]::MOUSEEVENTF_ABSOLUTE
    $move.mi.dx = 32768   # dead centre of the virtual screen, in 0..65535 space
    $move.mi.dy = 32768
    $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][VelaOsInput+INPUT])
    $sent = [VelaOsInput]::SendInput(1, @($move), $size)
    $lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Start-Sleep -Milliseconds 150
    $after = New-Object VelaOsInput+POINT
    [void][VelaOsInput]::GetCursorPos([ref]$after)

    $moved = ($after.X -ne $parked.X) -or ($after.Y -ne $parked.Y)
    $report.sendInputSelfTest = [ordered]@{
      structSize      = $size
      parkedAt        = [ordered]@{ x = $parked.X; y = $parked.Y }
      sendInputReturn = [int]$sent
      lastWin32Error  = $lastError
      cursorAfter     = [ordered]@{ x = $after.X; y = $after.Y }
      injectionWorks  = [bool]$moved
      note            = if ($moved) { 'SendInput moved the cursor: injected input reaches the desktop.' } else { 'SendInput reported success and the cursor did not move: injected input is being filtered in this process tree. Any sendinput click would be a silent no-op.' }
    }
    [void][VelaOsInput]::SetCursorPos($before.X, $before.Y)
    $report | ConvertTo-Json -Compress -Depth 6
    exit 0
  }

  # ---- delivery modes: work out who owns the pixel first --------------------

  [void][VelaOsInput]::SetCursorPos($X, $Y)
  Start-Sleep -Milliseconds 80

  $atClick = New-Object VelaOsInput+POINT
  [void][VelaOsInput]::GetCursorPos([ref]$atClick)
  $report.cursorAtClick = [ordered]@{ x = $atClick.X; y = $atClick.Y }

  $probe = New-Object VelaOsInput+POINT
  $probe.X = $X
  $probe.Y = $Y
  $under = [VelaOsInput]::WindowFromPoint($probe)
  $report.hwndUnderPoint = [int64]$under
  $underPid = 0
  if ($under -ne [IntPtr]::Zero) {
    $raw = [uint32]0
    [void][VelaOsInput]::GetWindowThreadProcessId($under, [ref]$raw)
    $underPid = [int]$raw
    $report.hwndUnderPointPid = $underPid
    $ancestry = Get-Ancestry $underPid
    $report.hwndUnderPointAncestry = $ancestry
    if ($RequirePid -gt 0) {
      $report.ownsTargetPixel = [bool](($ancestry | Where-Object { $_.pid -eq $RequirePid } | Measure-Object).Count -gt 0)
    }
  }

  if ($RequirePid -gt 0 -and $report.ownsTargetPixel -ne $true) {
    $report.blocked = $true
    $report.blockedReason = "the window under ($X,$Y) belongs to pid $underPid, which is not pid $RequirePid nor a descendant. Nothing was sent."
  } elseif ($Mode -eq 'sendinput') {
    $down = New-Object VelaOsInput+INPUT
    $down.type = [VelaOsInput]::INPUT_MOUSE
    $down.mi.dwFlags = [VelaOsInput]::MOUSEEVENTF_LEFTDOWN
    $up = New-Object VelaOsInput+INPUT
    $up.type = [VelaOsInput]::INPUT_MOUSE
    $up.mi.dwFlags = [VelaOsInput]::MOUSEEVENTF_LEFTUP
    $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][VelaOsInput+INPUT])
    $sent = [VelaOsInput]::SendInput(2, @($down, $up), $size)
    $report.detail = [ordered]@{
      api             = 'SendInput'
      eventsRequested = 2
      eventsAccepted  = [int]$sent
      lastWin32Error  = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      caveat          = 'SendInput returning 2 is NOT evidence that anything was delivered; run -Mode selftest.'
    }
    $report.delivered = ($sent -eq 2)
  } else {
    # message mode
    $client = New-Object VelaOsInput+POINT
    $client.X = $X
    $client.Y = $Y
    [void][VelaOsInput]::ScreenToClient($under, [ref]$client)
    $lParam = [IntPtr]((($client.Y -band 0xFFFF) -shl 16) -bor ($client.X -band 0xFFFF))
    $moveOk = [VelaOsInput]::PostMessageW($under, [VelaOsInput]::WM_MOUSEMOVE, [IntPtr]0, $lParam)
    $downOk = [VelaOsInput]::PostMessageW($under, [VelaOsInput]::WM_LBUTTONDOWN, [IntPtr][VelaOsInput]::MK_LBUTTON, $lParam)
    Start-Sleep -Milliseconds 40
    $upOk = [VelaOsInput]::PostMessageW($under, [VelaOsInput]::WM_LBUTTONUP, [IntPtr]0, $lParam)
    $report.detail = [ordered]@{
      api          = 'PostMessageW'
      targetHwnd   = [int64]$under
      clientPoint  = [ordered]@{ x = $client.X; y = $client.Y }
      posted       = [ordered]@{ mousemove = $moveOk; lbuttondown = $downOk; lbuttonup = $upOk }
      caveat       = 'A Win32 window message, not OS input. Chromium hit-tests the client point; the window was chosen here.'
    }
    $report.delivered = ($downOk -and $upOk)
  }

  Start-Sleep -Milliseconds 150
  [void][VelaOsInput]::SetCursorPos($before.X, $before.Y)
} catch {
  $report.error = $_.Exception.Message
}

$report | ConvertTo-Json -Compress -Depth 6
