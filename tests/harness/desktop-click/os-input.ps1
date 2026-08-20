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
  [ValidateSet('raise', 'selftest', 'sendinput', 'message', 'keyselftest', 'key', 'keys', 'text')]
  [string]$Mode = 'raise',
  # -Mode keys: `vk[+mod...][;vk[+mod...]...]`, decimal virtual-key codes, one
  # SendInput call for the whole run.
  [string]$Keys = '',
  # -Mode key: the Windows virtual-key code to press. Taken as a number, never
  # derived from a character here — `keys.mjs` owns that table, and deriving it
  # from the character is the defect that made `.` forward-delete.
  [int]$Vk = 0,
  # -Mode text: the string to deliver as KEYEVENTF_UNICODE events.
  [string]$Text = '',
  # Comma-separated: ctrl, shift, alt, win. Held around the key in -Mode key.
  [string]$Modifiers = '',
  [int]$Repeat = 1
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

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk; public ushort wScan;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    // The real INPUT union, declared as a union rather than as "the widest
    // member alone".
    //
    // The previous declaration was `struct INPUT { uint type; MOUSEINPUT mi; }`
    // with a comment saying MOUSEINPUT is the widest member so declaring it
    // alone gives the right size. That is true and it is also the reason there
    // was no way to send a keystroke: there was no field to put one in. Writing
    // the union out with LayoutKind.Explicit and both members at offset 0 keeps
    // the mouse layout byte-identical — `type` at 0, the union at the platform's
    // pointer alignment, 40 bytes total on x64 — while giving KEYBDINPUT a
    // correctly aligned home. Hand-padding a flat keyboard struct instead would
    // have put wVk at offset 4 on x64, where the union really starts at 8, and
    // SendInput would have accepted it and delivered a keystroke for whatever
    // virtual key the padding happened to spell. `Offsets()` below reports the
    // layout the runtime actually chose, so that claim is measured and not
    // asserted.
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const byte VK_MENU = 0x12;
    public const ushort VK_SHIFT = 0x10;
    public const ushort VK_CONTROL = 0x11;
    public const ushort VK_LWIN = 0x5B;

    public const uint WM_MOUSEMOVE = 0x0200;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public const int MK_LBUTTON = 0x0001;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    // -----------------------------------------------------------------------
    // EVERY `INPUT` IS BUILT HERE, AND NEVER IN POWERSHELL.
    //
    // Windows PowerShell 5.1 silently discards a write to a nested value-type
    // field: `$input.mi.dwFlags = 2` mutates a temporary copy of `mi` and
    // throws it away, leaving the struct all-zero. `SendInput` then accepts the
    // events and delivers nothing — it returns the count it was given and
    // `GetLastError` reports a stale 203 — which is indistinguishable from an
    // environment that filters injected input. This harness read it as exactly
    // that and told six other tracks that SendInput does not work on this
    // machine. It does. The struct was empty.
    //
    // The flags are parameters and the assembly is C#, so the failure cannot
    // recur: there is no nested field for a script to assign to.
    // -----------------------------------------------------------------------

    private static INPUT Mouse(uint flags, int dx, int dy)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dwFlags = flags;
        input.u.mi.dx = dx;
        input.u.mi.dy = dy;
        input.u.mi.mouseData = 0;
        input.u.mi.time = 0;
        input.u.mi.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    /// EVERY KEYBOARD `INPUT` IS BUILT HERE TOO, for the same reason and with
    /// the same rule: no PowerShell may ever assign `$x.u.ki.wVk`.
    private static INPUT Key(ushort vk, ushort scan, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = scan;
        input.u.ki.dwFlags = flags;
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    public static int Size() { return Marshal.SizeOf(typeof(INPUT)); }

    /// The layout the runtime actually chose, so "the union is correct" is a
    /// measurement rather than a comment. Measured on this machine, x64,
    /// Windows PowerShell 5.1.26100.9168:
    ///
    ///   size=40 type@0 union@8 mi.dwFlags@20 ki.wVk@8 ki.wScan@10
    ///   ki.dwFlags@12 keybdinputSize=24
    ///
    /// On x86 the union sits at 4 instead of 8 and every union-relative offset
    /// shifts with it. Either is right; a keyboard struct with `wVk` anywhere
    /// but at the union's own offset is not, which is what hand-padding a flat
    /// struct to 40 bytes would have produced. Read the value, do not trust
    /// this comment: it was written with `mi.dwFlags@12` before the first run
    /// printed 20.
    public static string Offsets()
    {
        return string.Format(
            "size={0} type@{1} union@{2} mi.dwFlags@{3} ki.wVk@{4} ki.wScan@{5} ki.dwFlags@{6} keybdinputSize={7}",
            Size(),
            Marshal.OffsetOf(typeof(INPUT), "type").ToInt64(),
            Marshal.OffsetOf(typeof(INPUT), "u").ToInt64(),
            Marshal.OffsetOf(typeof(INPUT), "u").ToInt64() + Marshal.OffsetOf(typeof(MOUSEINPUT), "dwFlags").ToInt64(),
            Marshal.OffsetOf(typeof(INPUT), "u").ToInt64() + Marshal.OffsetOf(typeof(KEYBDINPUT), "wVk").ToInt64(),
            Marshal.OffsetOf(typeof(INPUT), "u").ToInt64() + Marshal.OffsetOf(typeof(KEYBDINPUT), "wScan").ToInt64(),
            Marshal.OffsetOf(typeof(INPUT), "u").ToInt64() + Marshal.OffsetOf(typeof(KEYBDINPUT), "dwFlags").ToInt64(),
            Marshal.SizeOf(typeof(KEYBDINPUT)));
    }

    /// The bytes the harness is about to hand the API, so a caller can assert
    /// the struct is populated without moving anything. This is the check that
    /// would have caught the empty-struct defect the first time.
    public static string DescribeMouseInput(uint flags, int dx, int dy)
    {
        INPUT input = Mouse(flags, dx, dy);
        return string.Format("size={0} type={1} dwFlags={2} dx={3} dy={4}",
            Size(), input.type, input.u.mi.dwFlags, input.u.mi.dx, input.u.mi.dy);
    }

    /// Same, for a keystroke. An all-zero KEYBDINPUT is `wVk=0 wScan=0`, which
    /// SendInput accepts and which delivers a keystroke for virtual key 0 —
    /// indistinguishable at the return value from a working call.
    public static string DescribeKeyInput(ushort vk, ushort scan, uint flags)
    {
        INPUT input = Key(vk, scan, flags);
        return string.Format("size={0} type={1} wVk={2} wScan={3} dwFlags={4}",
            Size(), input.type, input.u.ki.wVk, input.u.ki.wScan, input.u.ki.dwFlags);
    }

    /// Absolute move, in the 0..65535 virtual-screen space SendInput expects.
    public static uint MoveAbsolute(int nx, int ny)
    {
        INPUT[] events = new INPUT[] { Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, nx, ny) };
        return SendInput(1, events, Size());
    }

    public static uint LeftClick()
    {
        INPUT[] events = new INPUT[] {
            Mouse(MOUSEEVENTF_LEFTDOWN, 0, 0),
            Mouse(MOUSEEVENTF_LEFTUP, 0, 0),
        };
        return SendInput(2, events, Size());
    }

    // -----------------------------------------------------------------------
    // KEYBOARD
    // -----------------------------------------------------------------------

    [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint uCode, uint uMapType);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);

    /// Keys that carry the E0 prefix. Sending one without KEYEVENTF_EXTENDEDKEY
    /// produces the *numpad* key of the same scan code: an unflagged VK_DELETE
    /// is the numpad `.`, and an unflagged VK_HOME is numpad 7. That is a
    /// wrong-key defect of exactly the shape the CDP path already shipped once
    /// (`.` sent as VK_DELETE), so the set is written out rather than guessed.
    private static readonly ushort[] EXTENDED = new ushort[] {
        0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, // PRIOR NEXT END HOME LEFT UP RIGHT DOWN
        0x2D, 0x2E,                                     // INSERT DELETE
        0x5B, 0x5C, 0x5D,                               // LWIN RWIN APPS
        0x6F, 0x90,                                     // DIVIDE NUMLOCK
        0xA3, 0xA5,                                     // RCONTROL RMENU
    };

    public static bool IsExtended(ushort vk)
    {
        for (int i = 0; i < EXTENDED.Length; i++) { if (EXTENDED[i] == vk) { return true; } }
        return false;
    }

    /// The hardware scan code for a virtual key on the *active* layout, asked of
    /// Windows rather than tabulated here. MAPVK_VK_TO_VSC = 0.
    public static ushort ScanFor(ushort vk) { return (ushort)MapVirtualKeyW(vk, 0); }

    private static INPUT VkEvent(ushort vk, bool keyUp)
    {
        uint flags = 0;
        if (IsExtended(vk)) { flags |= KEYEVENTF_EXTENDEDKEY; }
        if (keyUp) { flags |= KEYEVENTF_KEYUP; }
        return Key(vk, ScanFor(vk), flags);
    }

    /// One virtual key, pressed and released, with `modifiers` held around it.
    /// The modifiers go down in order and come up in reverse, which is what a
    /// human hand does and what shortcut handlers assume.
    public static uint PressVk(ushort vk, ushort[] modifiers)
    {
        List<INPUT> events = new List<INPUT>();
        for (int i = 0; i < modifiers.Length; i++) { events.Add(VkEvent(modifiers[i], false)); }
        events.Add(VkEvent(vk, false));
        events.Add(VkEvent(vk, true));
        for (int i = modifiers.Length - 1; i >= 0; i--) { events.Add(VkEvent(modifiers[i], true)); }
        INPUT[] array = events.ToArray();
        return SendInput((uint)array.Length, array, Size());
    }

    /// A whole run of keystrokes in ONE SendInput call.
    ///
    /// Not an optimisation. Starting `powershell.exe` and JIT-compiling this
    /// type costs about a second, so a per-character process would make
    /// `type --via os` take a minute on a URL and would interleave with
    /// whatever else the desktop is doing between characters. One call also
    /// means the whole run is atomic with respect to other injected input.
    ///
    /// `spec` is `vk[+mod[+mod...]][;...]`, virtual-key codes in decimal — the
    /// same codes `keys.mjs` tabulates for the CDP route, passed through rather
    /// than re-derived, because deriving a virtual-key code from a character is
    /// the exact defect that made `.` forward-delete on the CDP path.
    public static uint PressSequence(string spec, out int requested, out string firstAsBuilt)
    {
        List<INPUT> events = new List<INPUT>();
        firstAsBuilt = "";
        string[] entries = spec.Split(';');
        for (int e = 0; e < entries.Length; e++)
        {
            string entry = entries[e].Trim();
            if (entry.Length == 0) { continue; }
            string[] parts = entry.Split('+');
            ushort vk = ushort.Parse(parts[0]);
            List<ushort> mods = new List<ushort>();
            for (int p = 1; p < parts.Length; p++) { mods.Add(ushort.Parse(parts[p])); }
            for (int i = 0; i < mods.Count; i++) { events.Add(VkEvent(mods[i], false)); }
            if (firstAsBuilt.Length == 0)
            {
                uint f = 0;
                if (IsExtended(vk)) { f |= KEYEVENTF_EXTENDEDKEY; }
                firstAsBuilt = DescribeKeyInput(vk, ScanFor(vk), f);
            }
            events.Add(VkEvent(vk, false));
            events.Add(VkEvent(vk, true));
            for (int i = mods.Count - 1; i >= 0; i--) { events.Add(VkEvent(mods[i], true)); }
        }
        requested = events.Count;
        if (events.Count == 0) { return 0; }
        INPUT[] array = events.ToArray();
        return SendInput((uint)array.Length, array, Size());
    }

    /// Text as KEYEVENTF_UNICODE events: `wVk` must be 0 and `wScan` carries the
    /// UTF-16 code unit. This is the route that does NOT go through a keyboard
    /// layout, so it delivers characters no US key produces — and it is also the
    /// route that produces no meaningful virtual-key code, so a handler reading
    /// `event.keyCode` sees 0. Both facts are reported by the caller; neither is
    /// a reason to prefer one route silently.
    ///
    /// A surrogate pair is two code units and is sent as two events, which is
    /// what Windows expects.
    public static uint SendUnicode(string text)
    {
        List<INPUT> events = new List<INPUT>();
        for (int i = 0; i < text.Length; i++)
        {
            events.Add(Key(0, (ushort)text[i], KEYEVENTF_UNICODE));
            events.Add(Key(0, (ushort)text[i], KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        if (events.Count == 0) { return 0; }
        INPUT[] array = events.ToArray();
        return SendInput((uint)array.Length, array, Size());
    }

    /// Proves an injected keystroke reaches the system input state, without a
    /// window, without focus, and without typing a character anywhere.
    ///
    /// `SendInput` returning the count it was given is not evidence — that is
    /// the exact reading that cost this project a week on the mouse path. So
    /// this holds VK_SHIFT down and asks `GetAsyncKeyState`, which reads the
    /// global asynchronous key state maintained by the raw input thread and
    /// therefore needs no message pump in this process. Shift alone produces no
    /// character, and it is released and re-checked so a stuck modifier is
    /// reported rather than left behind.
    ///
    /// Returns a `|`-joined record so the caller can print exactly what happened.
    public static string KeyboardSelfTest()
    {
        // Clear the "pressed since last call" low bit and see whether a human is
        // already holding shift; if they are, the measurement below is not ours.
        bool downBefore = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        string built = DescribeKeyInput(VK_SHIFT, ScanFor(VK_SHIFT), 0);

        INPUT[] down = new INPUT[] { VkEvent(VK_SHIFT, false) };
        uint sentDown = SendInput(1, down, Size());
        int downError = Marshal.GetLastWin32Error();
        System.Threading.Thread.Sleep(80);
        bool observedDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;

        INPUT[] up = new INPUT[] { VkEvent(VK_SHIFT, true) };
        uint sentUp = SendInput(1, up, Size());
        System.Threading.Thread.Sleep(80);
        bool observedUp = (GetAsyncKeyState(VK_SHIFT) & 0x8000) == 0;

        return string.Format(
            "structAsBuilt={0}|offsets={1}|shiftHeldBefore={2}|sentDown={3}|sentUp={4}|lastWin32Error={5}|observedDown={6}|releasedAfter={7}",
            built, Offsets(), downBefore, sentDown, sentUp, downError, observedDown, observedUp);
    }

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
  keyboardSelfTest       = $null
  detail                 = $null
  error                  = $null
}

# Modifier names → virtual-key codes. VK_MENU (0x12) is ALT; the name is the
# Win32 one and is spelled out here so nobody reads "menu" as the context-menu
# key, which is VK_APPS (0x5D) and is a different key entirely.
$MODIFIER_VKS = @{ ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; menu = 0x12; win = 0x5B; meta = 0x5B }

function Get-ModifierVks([string]$spec) {
  if ([string]::IsNullOrWhiteSpace($spec)) { return @() }
  $out = @()
  foreach ($name in ($spec -split '[,+]')) {
    $key = $name.Trim().ToLowerInvariant()
    if ($key.Length -eq 0) { continue }
    if (-not $MODIFIER_VKS.ContainsKey($key)) { throw "unknown modifier '$key'" }
    $out += [uint16]$MODIFIER_VKS[$key]
  }
  return , [uint16[]]$out
}

# The keyboard self-test, parsed out of the `|`-joined record the C# returns.
# Run before every delivery, for the same reason the mouse one is: SendInput
# returns the count it was handed whether or not anything reached the desktop.
function Invoke-KeyboardSelfTest {
  $record = [VelaOsInput]::KeyboardSelfTest()
  $fields = [ordered]@{}
  foreach ($pair in ($record -split '\|')) {
    $i = $pair.IndexOf('=')
    if ($i -gt 0) { $fields[$pair.Substring(0, $i)] = $pair.Substring($i + 1) }
  }
  $observedDown = ($fields['observedDown'] -eq 'True')
  $released = ($fields['releasedAfter'] -eq 'True')
  $heldBefore = ($fields['shiftHeldBefore'] -eq 'True')
  return [ordered]@{
    structAsBuilt          = $fields['structAsBuilt']
    offsets                = $fields['offsets']
    shiftHeldBeforeTest    = $heldBefore
    sendInputReturnDown    = $fields['sentDown']
    sendInputReturnUp      = $fields['sentUp']
    lastWin32Error         = $fields['lastWin32Error']
    observedDown           = $observedDown
    releasedAfter          = $released
    keyboardInjectionWorks = ($observedDown -and $released)
    method                 = 'Held VK_SHIFT with SendInput and read GetAsyncKeyState, which reads the global async key state and needs no message pump. Shift alone types nothing. The return value of SendInput is NOT the evidence; observedDown is.'
    sideEffect             = 'This self-test runs AFTER the window is raised, so the focused control receives a real VK_SHIFT keydown and keyup of its own. Measured against a WinForms TextBox: the KeyDown log read <16><16><86>... for a run whose first character was a capital V. It produces no character and is released, but a handler that listens for a bare Shift keydown WILL see one extra. Subtract it before reading a key log.'
    note                   = if ($heldBefore) {
      'A shift key was ALREADY down when the test started, so observedDown may be somebody else. Treat this run as inconclusive.'
    } elseif ($observedDown -and $released) {
      'Injected keystrokes reach the system input state, and nothing was left held.'
    } elseif ($observedDown -and -not $released) {
      'SHIFT IS STILL DOWN. The press was delivered and the release was not. Press and release shift by hand before trusting anything typed after this.'
    } else {
      'SendInput accepted the keystroke and the async key state did not change. Check structAsBuilt and offsets FIRST: an all-zero or mis-aligned KEYBDINPUT is a harness bug, not a filtered environment, and this harness once mistook one for the other on the mouse path.'
    }
  }
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

    # 32768,32768 is dead centre of the virtual screen in the 0..65535 space
    # SendInput's absolute mode uses. The struct is assembled in C#; see the
    # comment on VelaOsInput.Mouse for why that is not a style preference.
    $struct = [VelaOsInput]::DescribeMouseInput(
      ([VelaOsInput]::MOUSEEVENTF_MOVE -bor [VelaOsInput]::MOUSEEVENTF_ABSOLUTE), 32768, 32768)
    $sent = [VelaOsInput]::MoveAbsolute(32768, 32768)
    $lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Start-Sleep -Milliseconds 150
    $after = New-Object VelaOsInput+POINT
    [void][VelaOsInput]::GetCursorPos([ref]$after)

    $moved = ($after.X -ne $parked.X) -or ($after.Y -ne $parked.Y)
    $report.sendInputSelfTest = [ordered]@{
      structSize      = [VelaOsInput]::Size()
      structAsBuilt   = $struct
      parkedAt        = [ordered]@{ x = $parked.X; y = $parked.Y }
      sendInputReturn = [int]$sent
      lastWin32Error  = $lastError
      cursorAfter     = [ordered]@{ x = $after.X; y = $after.Y }
      injectionWorks  = [bool]$moved
      note            = if ($moved) { 'SendInput moved the cursor: injected input reaches the desktop.' } else { 'SendInput reported success and the cursor did not move. Check structAsBuilt FIRST: an all-zero struct is a harness bug, not a filtered environment, and this harness once mistook one for the other.' }
    }
    # `lastWin32Error` is reported and deliberately not interpreted: 203 comes
    # back identically from the call that works and the call that does nothing,
    # so it is stale residue and never evidence.
    [void][VelaOsInput]::SetCursorPos($before.X, $before.Y)
    $report | ConvertTo-Json -Compress -Depth 6
    exit 0
  }

  if ($Mode -eq 'keyselftest') {
    $report.keyboardSelfTest = Invoke-KeyboardSelfTest
    $report | ConvertTo-Json -Compress -Depth 6
    exit 0
  }

  # ---- keyboard delivery ----------------------------------------------------
  #
  # There is no pixel to own here: SendInput keyboard events go to whatever has
  # the foreground, so the guard is the *raise* above. If -OwnerPid was given
  # and the raise did not succeed, refuse — otherwise this types into whatever
  # window happens to be in front, which on this machine has meant somebody
  # else's editor.
  if ($Mode -eq 'key' -or $Mode -eq 'keys' -or $Mode -eq 'text') {
    $foreground = [VelaOsInput]::GetForegroundWindow()
    $fgPid = [uint32]0
    [void][VelaOsInput]::GetWindowThreadProcessId($foreground, [ref]$fgPid)
    $report.hwndUnderPoint = [int64]$foreground
    $report.hwndUnderPointPid = [int]$fgPid
    $fgAncestry = Get-Ancestry ([int]$fgPid)
    $report.hwndUnderPointAncestry = $fgAncestry
    if ($RequirePid -gt 0) {
      $report.ownsTargetPixel = [bool](($fgAncestry | Where-Object { $_.pid -eq $RequirePid } | Measure-Object).Count -gt 0)
      if ($report.ownsTargetPixel -ne $true) {
        $report.blocked = $true
        $report.blockedReason = "the foreground window belongs to pid $fgPid, which is not pid $RequirePid nor a descendant. Keyboard input goes to the foreground, so NOTHING WAS SENT: it would have been typed into another application."
        $report | ConvertTo-Json -Compress -Depth 6
        exit 0
      }
    }

    $selfTest = Invoke-KeyboardSelfTest
    $report.keyboardSelfTest = $selfTest
    if (-not $selfTest.keyboardInjectionWorks) {
      $report.blocked = $true
      $report.blockedReason = 'the keyboard self-test did not observe its own keystroke, so nothing was sent. See keyboardSelfTest.structAsBuilt and .offsets before concluding the environment filters input.'
      $report | ConvertTo-Json -Compress -Depth 6
      exit 0
    }

    if ($Mode -eq 'key') {
      if ($Vk -le 0 -or $Vk -gt 254) { throw "-Vk must be a virtual-key code in 1..254, got $Vk" }
      $vk16 = [uint16]$Vk
      $mods = Get-ModifierVks $Modifiers
      # NOT `cond ? a : b` — the ternary operator is PowerShell 7+ and this file
      # runs under Windows PowerShell 5.1, where it is a parse error.
      $downFlags = [uint32]0
      if ([VelaOsInput]::IsExtended($vk16)) { $downFlags = [VelaOsInput]::KEYEVENTF_EXTENDEDKEY }
      $accepted = 0
      $expected = 0
      for ($i = 0; $i -lt [Math]::Max(1, $Repeat); $i++) {
        $accepted += [int][VelaOsInput]::PressVk($vk16, $mods)
        $expected += 2 + (2 * $mods.Length)
        Start-Sleep -Milliseconds 20
      }
      $report.detail = [ordered]@{
        api             = 'SendInput (INPUT_KEYBOARD)'
        vk              = $Vk
        scan            = [int][VelaOsInput]::ScanFor($vk16)
        extended        = [bool][VelaOsInput]::IsExtended($vk16)
        modifiers       = @($mods | ForEach-Object { [int]$_ })
        repeat          = [Math]::Max(1, $Repeat)
        eventsRequested = $expected
        eventsAccepted  = $accepted
        downAsBuilt     = [VelaOsInput]::DescribeKeyInput($vk16, [VelaOsInput]::ScanFor($vk16), $downFlags)
        caveat          = 'SendInput returning the count it was given is NOT evidence of delivery. keyboardSelfTest.observedDown is the evidence that injection works at all; only the application reading the keystroke is evidence that THIS one landed.'
      }
      $report.delivered = ($accepted -eq $expected)
    } elseif ($Mode -eq 'keys') {
      if ([string]::IsNullOrWhiteSpace($Keys)) { throw '-Mode keys needs -Keys' }
      $requested = 0
      $firstAsBuilt = ''
      $accepted = [int][VelaOsInput]::PressSequence($Keys, [ref]$requested, [ref]$firstAsBuilt)
      $report.detail = [ordered]@{
        api             = 'SendInput (INPUT_KEYBOARD, one call for the whole run)'
        keys            = $Keys
        eventsRequested = [int]$requested
        eventsAccepted  = $accepted
        firstAsBuilt    = $firstAsBuilt
        caveat          = 'Real virtual-key and scan codes on the active layout, so a handler reading event.key/keyCode sees what a keyboard produces. SendInput returning the count it was given is NOT evidence of delivery; keyboardSelfTest.observedDown is the evidence that injection works, and only the application reading the text is evidence that THIS run landed.'
      }
      $report.delivered = ($accepted -eq $requested -and $requested -gt 0)
    } else {
      if ($Text.Length -eq 0) { throw '-Mode text needs -Text' }
      $accepted = [int][VelaOsInput]::SendUnicode($Text)
      $expected = 2 * $Text.Length
      $report.detail = [ordered]@{
        api             = 'SendInput (INPUT_KEYBOARD, KEYEVENTF_UNICODE)'
        characters      = $Text.Length
        utf16CodeUnits  = $Text.Length
        eventsRequested = $expected
        eventsAccepted  = $accepted
        firstAsBuilt    = if ($Text.Length -gt 0) { [VelaOsInput]::DescribeKeyInput(0, [uint16][char]$Text[0], [VelaOsInput]::KEYEVENTF_UNICODE) } else { $null }
        caveat          = 'KEYEVENTF_UNICODE bypasses the keyboard layout, so it delivers characters no US key produces, and it reports NO meaningful virtual-key code: a handler reading event.keyCode sees 0. Use -Mode key for anything whose behaviour is keyboard-driven.'
      }
      $report.delivered = ($accepted -eq $expected)
    }

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
    $sent = [VelaOsInput]::LeftClick()
    $report.detail = [ordered]@{
      api             = 'SendInput'
      eventsRequested = 2
      eventsAccepted  = [int]$sent
      downAsBuilt     = [VelaOsInput]::DescribeMouseInput([VelaOsInput]::MOUSEEVENTF_LEFTDOWN, 0, 0)
      upAsBuilt       = [VelaOsInput]::DescribeMouseInput([VelaOsInput]::MOUSEEVENTF_LEFTUP, 0, 0)
      lastWin32Error  = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      caveat          = 'SendInput returning 2 is NOT evidence that anything was delivered; the page-side pointer recorder is. `downAsBuilt` is here so an all-zero struct can never again be read as a filtered environment.'
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
