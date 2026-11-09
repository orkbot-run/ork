# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

param(
  [Parameter(Mandatory = $true)][ValidateSet('sign', 'verify')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Metadata
)
$ErrorActionPreference = 'Stop'
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
  & $env:WINDOWS_SIGNTOOL_PATH sign /fd SHA256 /tr 'https://timestamp.acs.microsoft.com' /td SHA256 /dlib $env:WINDOWS_SIGNING_DLIB_PATH /dmdf $Metadata $Path *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Windows signing failed.' }
}
& $env:WINDOWS_SIGNTOOL_PATH verify /pa /tw $Path *> $null
if ($LASTEXITCODE -ne 0) { throw 'Windows signature verification failed.' }
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
