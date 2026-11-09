# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

param(
  [Parameter(Mandatory = $true)][ValidateSet('sign', 'verify')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Metadata
)
$ErrorActionPreference = 'Stop'
function Quote-NativeArgument([string]$value) {
  $result = [Text.StringBuilder]::new()
  [void]$result.Append('"')
  $slashes = 0
  foreach ($char in $value.ToCharArray()) {
    if ($char -eq '\') { $slashes++; continue }
    if ($char -eq '"') {
      [void]$result.Append(('\' * ($slashes * 2 + 1) -join ''))
    } else {
      [void]$result.Append(('\' * $slashes -join ''))
    }
    [void]$result.Append($char)
    $slashes = 0
  }
  [void]$result.Append(('\' * ($slashes * 2) -join ''))
  [void]$result.Append('"')
  return $result.ToString()
}
function Invoke-SignTool([string[]]$Arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $env:WINDOWS_SIGNTOOL_PATH
  $info.Arguments = (($Arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' ')
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  try {
    if (-not $process.Start()) { throw 'Windows signing tool failed.' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [void]$stdout.GetAwaiter().GetResult()
    [void]$stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw 'Windows signing tool failed.' }
  } catch {
    throw 'Windows signing tool failed.'
  } finally {
    $process.Dispose()
  }
}
if (-not [IO.Path]::IsPathRooted($env:WINDOWS_SIGNTOOL_PATH) -or
    -not (Test-Path -LiteralPath $env:WINDOWS_SIGNTOOL_PATH -PathType Leaf)) {
  throw 'Windows SignTool is unavailable.'
}
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Signing target is unavailable.' }
if ($Mode -eq 'sign') {
  if (-not [IO.Path]::IsPathRooted($env:WINDOWS_SIGNING_DLIB_PATH) -or
      -not (Test-Path -LiteralPath $env:WINDOWS_SIGNING_DLIB_PATH -PathType Leaf) -or
      -not $Metadata -or -not (Test-Path -LiteralPath $Metadata -PathType Leaf)) {
    throw 'Windows signing configuration is unavailable.'
  }
  Invoke-SignTool -Arguments @('sign', '/fd', 'SHA256', '/tr', 'https://timestamp.acs.microsoft.com', '/td', 'SHA256', '/dlib', $env:WINDOWS_SIGNING_DLIB_PATH, '/dmdf', $Metadata, $Path)
}
Invoke-SignTool -Arguments @('verify', '/pa', '/tw', $Path)
$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) {
  throw 'Windows signature or timestamp is invalid.'
}
if ($Mode -eq 'sign') {
  if (-not $env:WINDOWS_SIGNING_RECORD_PATH -or -not [IO.Path]::IsPathRooted($env:WINDOWS_SIGNING_RECORD_PATH)) {
    throw 'Windows signing record path is unavailable.'
  }
  $record = @{ path = [IO.Path]::GetFullPath($Path); sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash } | ConvertTo-Json -Compress
  Add-Content -LiteralPath $env:WINDOWS_SIGNING_RECORD_PATH -Value $record -Encoding UTF8
}
