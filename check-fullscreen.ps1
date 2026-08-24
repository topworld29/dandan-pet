# check-fullscreen.ps1 -- persistent fullscreen watcher.
# Started ONCE by main.js; prints one line "1" (fullscreen) or "0" (not) every 3s.
# Fullscreen requires BOTH:
#   1. foreground window has WS_POPUP style (0x80000000), typical of fullscreen apps
#   2. window covers the whole screen
# Add-Type compiles only once per app run (the old one-shot version recompiled every 3s).
# Exits by itself when the parent Electron process is gone.
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as GBK and mangles non-ASCII.
param([int]$parentPid = 0)
Add-Type -Name W -Namespace N -MemberDefinition @"
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,ref RECT r);
[DllImport("user32.dll")]public static extern int GetSystemMetrics(int n);
[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int idx);
public struct RECT{public int L;public int T;public int R;public int B;}
"@
while ($true) {
  if ($parentPid -gt 0) {
    try { $null = Get-Process -Id $parentPid -ErrorAction Stop } catch { exit }
  }
  $h = [N.W]::GetForegroundWindow()
  $r = New-Object N.W+RECT
  [void][N.W]::GetWindowRect($h, [ref]$r)   # [void]: keep GetWindowRect's bool out of stdout
  $w = [N.W]::GetSystemMetrics(0)
  $ht = [N.W]::GetSystemMetrics(1)
  $style = [N.W]::GetWindowLong($h, -16)
  $isPopup = ($style -band 0x80000000) -ne 0
  $coversScreen = ($r.L -le 0) -and ($r.T -le 0) -and ($r.R -ge $w) -and ($r.B -ge $ht)
  if ($isPopup -and $coversScreen) { [Console]::Out.WriteLine("1") } else { [Console]::Out.WriteLine("0") }
  [Console]::Out.Flush()
  Start-Sleep -Seconds 3
}
