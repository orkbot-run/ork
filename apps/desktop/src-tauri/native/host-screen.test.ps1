# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
$ErrorActionPreference = 'Stop'
$runDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ork-screen-fixture-" + [Guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $runDir)
$fixture = $null
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
$helper = Join-Path $PSScriptRoot 'host-screen.ps1'
function Invoke-Driver($request) {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = Join-Path $PSHome 'powershell.exe'
  $start.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$helper`""
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = $utf8
  $child = [System.Diagnostics.Process]::Start($start)
  try {
    $json = $request | ConvertTo-Json -Depth 8 -Compress
    $inputBytes = $utf8.GetBytes($json)
    $child.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $child.StandardInput.BaseStream.Close()
    $output = $child.StandardOutput.ReadToEndAsync()
    $errors = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(15000)) { throw 'Screen helper timed out.' }
    if ($child.ExitCode -ne 0) { throw ("Screen helper failed: " + $errors.Result) }
    return $output.Result | ConvertFrom-Json
  } finally {
    if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
    $child.Dispose()
  }
}
try {
  $fixtureExe = Join-Path $runDir 'OrkT242Fixture.exe'
  $received = Join-Path $runDir 'events.txt'
  $source = @'
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

public sealed class ScreenTestForm : Form
{
    private readonly string eventsFile;
    public ScreenTestForm(string eventsFile)
    {
        this.eventsFile = eventsFile;
        Text = "Ork T-242 fixture \u0142";
        BackColor = Color.RoyalBlue;
        StartPosition = FormStartPosition.Manual;
        Bounds = new Rectangle(80, 80, 360, 240);
        TopMost = true;
    }

    protected override void WndProc(ref Message message)
    {
        string line = null;
        switch (message.Msg)
        {
            case 0x200: if (message.LParam.ToInt64() != 0) line = "move"; break;
            case 0x201: line = "click"; break;
            case 0x102: line = "text:" + message.WParam.ToInt32(); break;
            case 0x100: if (message.WParam.ToInt32() == 9) line = "key:tab"; break;
            case 0x20a: line = "scroll:" + (message.WParam.ToInt32() >> 16); break;
        }
        if (line != null && eventsFile != null)
            File.AppendAllText(eventsFile, line + Environment.NewLine);
        base.WndProc(ref message);
    }

    [STAThread]
    public static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string eventsFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "events.txt");
        File.WriteAllText(eventsFile, "ready" + Environment.NewLine);
        Application.Run(new ScreenTestForm(eventsFile));
    }
}
'@
  Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing,System.Windows.Forms -OutputAssembly $fixtureExe -OutputType WindowsApplication
  $fixture = Start-Process -FilePath $fixtureExe -PassThru
  for ($i=0; $i -lt 40; $i++) {
    $fixture.Refresh()
    if ($fixture.HasExited) { throw 'Fixture failed to start.' }
    if ($fixture.MainWindowHandle -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 125
  }
  if ($fixture.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Windows has no interactive fixture window.' }
  if (!(Test-Path -LiteralPath $received)) { throw 'Fixture could not create its event log.' }
  $ready = Invoke-Driver @{method='capabilities'}
  if (!$ready.screen -or !$ready.control) { throw 'Native screen driver did not report ready.' }
  Write-Host 'Windows capability check passed.'
  $observed = Invoke-Driver @{method='screenObserve';app='OrkT242Fixture'}
  if (!$observed.image -or $observed.image.mimeType -ne 'image/png') { throw 'Did not observe the test window.' }
  if ($observed.title -cne ("Ork T-242 fixture " + [char]0x0142)) { throw 'Window title was damaged on the UTF-8 response channel.' }
  Add-Type -AssemblyName System.Drawing
  $png = [System.IO.MemoryStream]::new([Convert]::FromBase64String($observed.image.data))
  $picture = [System.Drawing.Bitmap]::new($png)
  try {
    $pixel = $picture.GetPixel([int]($picture.Width/2), [int]($picture.Height/2))
    if ($pixel.B -lt 160 -or $pixel.R -gt 140) { throw 'Capture does not contain the fixture content.' }
  } finally { $picture.Dispose(); $png.Dispose() }
  $missing = Invoke-Driver @{method='screenObserve';app='OrkT242FixtureMissing'}
  if (!$missing.error -or $missing.image) { throw 'A missing application did not fail closed.' }
  Write-Host 'Windows application screenshot and missing-target checks passed.'
  $result = Invoke-Driver @{method='screenAct';app='OrkT242Fixture';actions=@(
    @{kind='move';x=100;y=100},
    @{kind='click';x=100;y=100},
    @{kind='type';text=[string][char]0x0105},
    @{kind='key';key='tab'},
    @{kind='scroll';x=100;y=100;direction='down';amount=1}
  )}
  if ($result.completed -ne 5 -or $result.error -or !$result.observation.image) {
    throw ("Screen action batch failed: " + $result.completed + " completed. " + $result.error)
  }
  for ($i=0; $i -lt 30; $i++) {
    $events = if (Test-Path $received) { @(Get-Content -LiteralPath $received) } else { @() }
    $missingEvents = @('move','click','text:261','key:tab','scroll:-120') | Where-Object { $_ -notin $events }
    if (!$missingEvents) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($missingEvents) { throw ("Missing input events: " + ($missingEvents -join ', ') + ". Received: " + ($events -join ', ')) }
  $outOfBounds = Invoke-Driver @{method='screenAct';app='OrkT242Fixture';actions=@(@{kind='click';x=5000;y=5000})}
  if ($outOfBounds.completed -ne 0 -or !$outOfBounds.error) { throw 'An out-of-window click was accepted.' }
  Write-Host 'Windows verified: move, click, Polish text, key, scroll and rejected out-of-window click.'
} finally {
  if ($fixture) {
    if (-not $fixture.HasExited) { $fixture.Kill(); $fixture.WaitForExit() }
    $fixture.Dispose()
  }
  Remove-Item -Recurse -Force -LiteralPath $runDir
}
