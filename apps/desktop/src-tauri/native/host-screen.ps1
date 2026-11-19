# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
$ErrorActionPreference = 'Stop'
$completed = 0
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrkWindow {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
 [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr window, ref Point point);
 [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr window, Point point, uint flags);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo { public uint Size, Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect; }
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
 public static IntPtr KeyboardTarget(IntPtr window, uint expectedPid) {
   uint owner; uint thread = GetWindowThreadProcessId(window, out owner);
   if (owner != expectedPid) return IntPtr.Zero;
   GuiThreadInfo info = new GuiThreadInfo(); info.Size = (uint)Marshal.SizeOf(info);
   if (GetGUIThreadInfo(thread, ref info) && info.Focus != IntPtr.Zero) {
     GetWindowThreadProcessId(info.Focus, out owner);
     if (owner == expectedPid) return info.Focus;
   }
   return window;
 }
 [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
  [void][OrkWindow]::SetProcessDPIAware()
  if ($request.method -eq 'permissions' -or $request.method -eq 'capabilities') {
    $ready = [Environment]::UserInteractive -and [OrkWindow]::GetThreadDesktop([OrkWindow]::GetCurrentThreadId()) -ne [IntPtr]::Zero
    if ($ready) { $probe = New-Object System.Drawing.Bitmap(1, 1); $probe.Dispose() }
    @{ screen = $ready; control = $ready } | ConvertTo-Json -Compress
    exit
  }
  # Exact process product/application name only. Never interpret an application as a path or command.
  $apps = @(Get-Process | Where-Object {
    if ($_.MainWindowHandle -eq 0) { return $false }
    if ($_.ProcessName -ieq $request.app) { return $true }
    try { return $_.MainModule.FileVersionInfo.FileDescription -ieq $request.app } catch { return $false }
  })
  if ($apps.Count -ne 1) { throw 'The approved application is not open or its name is ambiguous.' }
  $app = $apps[0]
  $window = $app.MainWindowHandle
  $processId = $app.Id
  $rect = New-Object OrkWindow+Rect
  if (-not [OrkWindow]::GetWindowRect($window, [ref]$rect)) { throw 'The approved application has no visible window.' }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0 -or $width -gt 20000 -or $height -gt 20000 -or ([long]$width * $height) -gt 16000000) { throw 'Invalid approved window dimensions.' }
  function Send-WindowMessage($target, [uint32]$message, [long]$wparam, [long]$lparam) {
    [uint32]$owner = 0
    [void][OrkWindow]::GetWindowThreadProcessId($target, [ref]$owner)
    if (-not [OrkWindow]::IsWindow($target) -or $owner -ne $processId) { throw 'The approved application closed. Observe it again.' }
    if (-not [OrkWindow]::PostMessage($target, $message, [IntPtr]$wparam, [IntPtr]$lparam)) { throw 'Windows refused input to the approved application.' }
  }
  if ($request.method -eq 'screenAct') {
    $actions = @($request.actions)
    if ($actions.Count -lt 1 -or $actions.Count -gt 24) { throw 'Invalid screen actions.' }
    foreach ($action in $actions) {
      $target = $window
      if ($action.kind -in @('type','key')) { $target = [OrkWindow]::KeyboardTarget($window, [uint32]$processId) }
      $position = 0
      if ($action.kind -eq 'click' -or $action.kind -eq 'move' -or $null -ne $action.x -or $null -ne $action.y) {
        if ($null -eq $action.x -or $null -eq $action.y -or $action.x -lt 0 -or $action.y -lt 0 -or $action.x -ge $width -or $action.y -ge $height) { throw 'Coordinates must be inside the approved window.' }
        $point = New-Object OrkWindow+Point
        $point.X = $rect.Left + [int]$action.x
        $point.Y = $rect.Top + [int]$action.y
        [void][OrkWindow]::ScreenToClient($window, [ref]$point)
        $child = [OrkWindow]::ChildWindowFromPointEx($window, $point, 7)
        if ($child -ne [IntPtr]::Zero -and $child -ne $window) {
          $point.X = $rect.Left + [int]$action.x; $point.Y = $rect.Top + [int]$action.y
          [void][OrkWindow]::ScreenToClient($child, [ref]$point)
          $target = $child
        }
        $position = ($point.Y -shl 16) -bor ($point.X -band 65535)
      }
      switch ($action.kind) {
        'move' { Send-WindowMessage $target 0x200 0 $position }
        'click' {
          $down = 0x201; $up = 0x202; $button = 1
          if ($action.button -eq 'right') { $down = 0x204; $up = 0x205; $button = 2 }
          $count = 1; if ($action.double) { $count = 2 }
          for ($i = 0; $i -lt $count; $i++) { Send-WindowMessage $target $down $button $position; Send-WindowMessage $target $up 0 $position }
        }
        'type' {
          if ($action.text.Length -gt 10000) { throw 'Invalid text.' }
          foreach ($character in $action.text.ToCharArray()) { Send-WindowMessage $target 0x102 ([int]$character) 1 }
        }
        'key' {
          if ($null -ne $action.modifiers -and $action.modifiers.Count -gt 0) { throw 'Key combinations are unavailable for app-scoped input on Windows.' }
          $keys = @{ enter=13; return=13; tab=9; space=32; backspace=8; escape=27; esc=27; delete=46; home=36; end=35; pageup=33; pagedown=34; left=37; up=38; right=39; down=40 }
          $key = $keys[$action.key.ToLowerInvariant()]
          if ($null -eq $key -and $action.key.Length -eq 1) { $key = [int][char]$action.key.ToUpperInvariant() }
          if ($null -eq $key) { throw 'Unsupported key.' }
          Send-WindowMessage $target 0x100 $key 1
          Send-WindowMessage $target 0x101 $key -1073741823
        }
        'scroll' {
          $amount = 3; if ($null -ne $action.amount) { $amount = [int]$action.amount }
          if ($amount -lt 1 -or $amount -gt 20) { throw 'Invalid scroll amount.' }
          $message = 0x20A; $delta = $amount * 120
          if ($action.direction -eq 'down' -or $action.direction -eq 'left') { $delta = -$delta }
          if ($action.direction -eq 'left' -or $action.direction -eq 'right') { $message = 0x20E }
          if ($action.direction -notin @('up','down','left','right')) { throw 'Invalid scroll direction.' }
          $x = $rect.Left + [int]($width / 2); $y = $rect.Top + [int]($height / 2)
          if ($null -ne $action.x) { $x = $rect.Left + [int]$action.x; $y = $rect.Top + [int]$action.y }
          Send-WindowMessage $target $message ($delta -shl 16) (($y -shl 16) -bor ($x -band 65535))
        }
        'wait' { if ($action.ms -lt 0 -or $action.ms -gt 5000) { throw 'Invalid wait duration.' }; Start-Sleep -Milliseconds $action.ms }
        default { throw 'This action requires an accessibility element driver. Use window coordinates or keys.' }
      }
      $completed++
    }
  } elseif ($request.method -ne 'screenObserve') { throw 'Invalid screen method.' }
  if ($completed -gt 0) { Start-Sleep -Milliseconds 100 }
  # PrintWindow renders only this application's window, never the desktop rectangle behind it.
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $dc = $graphics.GetHdc()
  try {
    [uint32]$captureOwner = 0
    [void][OrkWindow]::GetWindowThreadProcessId($window, [ref]$captureOwner)
    if ($captureOwner -ne $processId -or -not [OrkWindow]::PrintWindow($window, $dc, 2)) { throw 'The approved application does not support window capture.' }
    [void][OrkWindow]::GetWindowThreadProcessId($window, [ref]$captureOwner)
    if ($captureOwner -ne $processId) { throw 'The approved application closed during capture.' }
  }
  finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
  $stream = New-Object System.IO.MemoryStream
  try { $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); $encoded = [Convert]::ToBase64String($stream.ToArray()) }
  finally { $bitmap.Dispose(); $stream.Dispose() }
  $observation = @{ app=$request.app; title=$app.MainWindowTitle; tree='Approved application window. Coordinates use this image''s pixels.'; image=@{mimeType='image/png';data=$encoded;width=$width;height=$height} }
  if ($request.method -eq 'screenAct') { @{completed=$completed;observation=$observation} | ConvertTo-Json -Depth 6 -Compress }
  else { $observation | ConvertTo-Json -Depth 6 -Compress }
} catch {
  if ($request.method -eq 'screenAct') {
    @{completed=$completed;error='The approved application could not finish the action batch. Observe the window before retrying.'} | ConvertTo-Json -Compress
  } else {
    @{error='The approved application could not be captured. Check its permissions and observe again.'} | ConvertTo-Json -Compress
  }
}
