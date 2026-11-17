# Acceptance check for the taskbar strip, with the real pointer. It moves the mouse for
# about a minute, clicks inside the panel and on the strip, and puts the pointer back.
#   1. three times: point at the strip -> the panel shows; move away -> it hides;
#   2. cold start: restart the client and point at once -> the panel shows when loaded;
#   3. a click inside the panel gives it the keyboard (a reply can be typed); two clicks
#      on the strip pin and hide it.
# While the pointer only points, the keyboard focus is sampled every 50 ms: neither the
# panel nor the strip may have it at any moment. There must be exactly one panel window.
# Each line ends in OK or FAIL; the exit code is the number of failures.
# Run:  powershell -ExecutionPolicy Bypass -File test-hover.ps1 [-Shots <folder>]
param([string]$Shots = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class HoverCheck {
  public delegate bool Visitor(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visitor, IntPtr state);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  // Top-level windows of one process, shown or hidden; with a title when one is given.
  public static List<IntPtr> Windows(int process, string title) {
    var found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr window, IntPtr state) {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner != process) return true;
      if (title != null) { var text = new StringBuilder(160); GetWindowText(window, text, 160); if (text.ToString() != title) return true; }
      found.Add(window); return true; }, IntPtr.Zero);
    return found; }
  // The client's strip: its visible window that is wide and as low as a taskbar.
  public static bool StripOf(int process, out Rect strip) {
    Rect best = new Rect(); bool any = false;
    foreach (IntPtr window in Windows(process, null)) {
      if (!IsWindowVisible(window)) continue;
      Rect r; GetWindowRect(window, out r);
      if (r.Right - r.Left > 60 && r.Bottom - r.Top <= 120) { best = r; any = true; } }
    strip = best; return any; }
  public static bool OwnsForeground(int process) { uint owner; GetWindowThreadProcessId(GetForegroundWindow(), out owner); return owner == process; }
  public static void Click() { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
}
'@
[void][HoverCheck]::SetProcessDPIAware()
$failures = 0
function Report([string]$what, [bool]$ok, [string]$detail = '') {
    if (-not $ok) { $script:failures++ }
    Write-Output ("{0,-62} {1} {2}" -f $what, $(if ($ok) { 'OK' } else { 'FAIL' }), $detail)
}
function Client { Get-Process -Name 'bb Status' -ErrorAction SilentlyContinue | Select-Object -First 1 }
function Panels { $client = Client; if (-not $client) { return @() }; @([HoverCheck]::Windows($client.Id, 'bb Status panel')) }
function Shown { @(Panels | Where-Object { [HoverCheck]::IsWindowVisible($_) }) }
function Until([scriptblock]$condition, [double]$seconds) {
    $end = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $end) { if (& $condition) { return $true }; Start-Sleep -Milliseconds 100 }
    return [bool](& $condition)
}
# For the given time: how long, in ms, a window of the client had the keyboard (sampled every 50 ms).
function FocusTaken([double]$seconds) {
    $client = Client; $taken = 0; $watch = [Diagnostics.Stopwatch]::StartNew(); $previous = 0
    while ($watch.Elapsed.TotalSeconds -lt $seconds) {
        $now = $watch.ElapsedMilliseconds
        if ($client -and [HoverCheck]::OwnsForeground($client.Id)) { $taken += ($now - $previous) }
        $previous = $now; Start-Sleep -Milliseconds 50
    }
    return $taken
}
function Shot([string]$name) {
    if (-not $Shots) { return }
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $area = New-Object System.Drawing.Rectangle 0, ($screen.Height - 780), 1000, 780
    $bitmap = New-Object System.Drawing.Bitmap $area.Width, $area.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($area.Location, [System.Drawing.Point]::Empty, $area.Size)
    $bitmap.Save((Join-Path $Shots $name)); $graphics.Dispose(); $bitmap.Dispose()
}
function StripCentre {
    $client = Client; if (-not $client) { return $null }
    $rect = New-Object HoverCheck+Rect
    if (-not [HoverCheck]::StripOf($client.Id, [ref]$rect)) { return $null }
    return @([int](($rect.Left + $rect.Right) / 2), [int](($rect.Top + $rect.Bottom) / 2), $rect)
}

$inside = StripCentre
if (-not $inside) { Write-Output 'bb Status is not running or shows no strip (is BB Desktop open, ui=strip?)'; exit 99 }
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$away = @([int]($bounds.Width * 0.72), [int]($bounds.Height * 0.35))
$cursor = [System.Windows.Forms.Cursor]::Position
$owner = 0; [void][HoverCheck]::GetWindowThreadProcessId([HoverCheck]::GetForegroundWindow(), [ref]$owner)
Write-Output ("strip {0},{1}-{2},{3}; program with the keyboard: {4}" -f $inside[2].Left, $inside[2].Top, $inside[2].Right, $inside[2].Bottom, (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName)
try {
    [void][HoverCheck]::SetCursorPos($away[0], $away[1]); Start-Sleep -Milliseconds 900
    Report 'ready: one panel window exists, hidden' ((Until { (Panels).Count -eq 1 } 20) -and (Shown).Count -eq 0) ("windows=" + (Panels).Count)
    foreach ($cycle in 1..3) {
        [void][HoverCheck]::SetCursorPos($inside[0], $inside[1])
        $taken = FocusTaken 1.6
        Report "cycle ${cycle}: pointing at the strip shows the panel" ((Shown).Count -eq 1) ("windows=" + (Panels).Count)
        if ($cycle -eq 2) { Shot 'hover-panel.png' }
        Report "cycle ${cycle}: the keyboard never left the user's window" ($taken -eq 0) "(${taken} ms)"
        [void][HoverCheck]::SetCursorPos($away[0], $away[1])
        $taken = FocusTaken 1.4
        Report "cycle ${cycle}: moving away hides it, keyboard untouched" ((Shown).Count -eq 0 -and $taken -eq 0) "(${taken} ms)"
    }
    # Cold start: a fresh client, pointed at before its page can have loaded.
    $client = Client; $path = $client.Path
    $client.Kill(); [void]$client.WaitForExit(5000)
    Start-Process explorer.exe -ArgumentList ('"' + $path + '"')
    [void](Until { Client } 10)
    [void](Until { StripCentre } 15)
    [void][HoverCheck]::SetCursorPos($inside[0], $inside[1])
    $taken = FocusTaken 6
    Report 'cold: a restarted client shows the panel when pointed at' ((Shown).Count -eq 1) ("windows=" + (Panels).Count)
    Report "cold: the keyboard never left the user's window" ($taken -eq 0) "(${taken} ms of 6000)"
    [void][HoverCheck]::SetCursorPos($away[0], $away[1])
    $taken = FocusTaken 1.4
    Report 'cold: moving away hides it, keyboard untouched' ((Shown).Count -eq 0 -and $taken -eq 0) "(${taken} ms)"
    Report 'cold: still exactly one panel window' ((Panels).Count -eq 1) ("windows=" + (Panels).Count)
    # A click inside the panel is the user taking it up: now it may have the keyboard.
    [void][HoverCheck]::SetCursorPos($inside[0], $inside[1]); [void](Until { (Shown).Count -eq 1 } 4)
    $panel = New-Object HoverCheck+Rect; [void][HoverCheck]::GetWindowRect((Shown)[0], [ref]$panel)
    [void][HoverCheck]::SetCursorPos([int]($panel.Left + ($panel.Right - $panel.Left) * 0.62), [int]($panel.Top + ($panel.Bottom - $panel.Top) * 0.75)); Start-Sleep -Milliseconds 400
    [HoverCheck]::Click(); Start-Sleep -Milliseconds 700
    Report 'click inside: the panel has the keyboard' ([HoverCheck]::OwnsForeground((Client).Id))
    [void][HoverCheck]::SetCursorPos($away[0], $away[1]); Start-Sleep -Milliseconds 1500
    Report 'click inside: it stays while it has the keyboard' ((Shown).Count -eq 1)
    # Two clicks on the strip: pin, then hide; the keyboard goes back to an ordinary window.
    [void][HoverCheck]::SetCursorPos($inside[0], $inside[1]); Start-Sleep -Milliseconds 300
    [HoverCheck]::Click(); Start-Sleep -Milliseconds 500; [HoverCheck]::Click(); Start-Sleep -Milliseconds 300
    [void][HoverCheck]::SetCursorPos($away[0], $away[1]); Start-Sleep -Milliseconds 1200
    Report 'strip clicks: the panel is hidden again' ((Shown).Count -eq 0)
    Report 'end: the client does not hold the keyboard' (-not [HoverCheck]::OwnsForeground((Client).Id))
} finally {
    [void][HoverCheck]::SetCursorPos($cursor.X, $cursor.Y)
}
Write-Output ("failures: {0}" -f $failures)
exit $failures
