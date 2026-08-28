param(
  [ValidateSet('x64', 'arm64')]
  [string]$Architecture = 'x64'
)

$ErrorActionPreference = 'Stop'
$ReleaseTag = 'autobuild-2026-08-27-16-45'
$Assets = @{
  x64 = @{
    Name = 'ffmpeg-n8.1.2-47-g156bb4d299-win64-lgpl-8.1.zip'
    Sha256 = '8863f90df77e13897ce7559a55fbbe14d6c5b7aa2a8e8cbb4c750c742d106793'
  }
  arm64 = @{
    Name = 'ffmpeg-n8.1.2-47-g156bb4d299-winarm64-lgpl-8.1.zip'
    Sha256 = '0412331a4f3b46998b2643c1b946852aaba1b74dbb1459db31dca40c100f5b30'
  }
}

$Asset = $Assets[$Architecture]
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Destination = Join-Path $ProjectRoot "vendor/ffmpeg/win32-$Architecture"
$Executable = Join-Path $Destination 'ffmpeg.exe'
$License = Join-Path $Destination 'LICENSE'
$Marker = Join-Path $Destination '.archive-sha256'

if ((Test-Path -LiteralPath $Executable -PathType Leaf) -and
    (Test-Path -LiteralPath $License -PathType Leaf) -and
    (Test-Path -LiteralPath $Marker -PathType Leaf) -and
    ((Get-Content -LiteralPath $Marker -Raw).Trim() -eq $Asset.Sha256)) {
  Write-Host "Bundled FFmpeg is already prepared for Windows $Architecture."
  exit 0
}

$TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "dji-cloud-studio-ffmpeg-$([Guid]::NewGuid())"
$ArchivePath = Join-Path $TemporaryRoot $Asset.Name
$ExtractPath = Join-Path $TemporaryRoot 'extracted'
$Url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$ReleaseTag/$($Asset.Name)"

try {
  New-Item -ItemType Directory -Path $TemporaryRoot, $ExtractPath -Force | Out-Null
  for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    try {
      Invoke-WebRequest -Uri $Url -OutFile $ArchivePath -UseBasicParsing
      break
    } catch {
      if ($Attempt -eq 3) { throw }
      Write-Warning "FFmpeg download attempt $Attempt failed; retrying. $($_.Exception.Message)"
      Start-Sleep -Seconds (2 * $Attempt)
    }
  }
  $ActualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $Asset.Sha256) {
    throw "SHA-256 mismatch for $Url`: expected $($Asset.Sha256), got $ActualSha256"
  }

  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractPath -Force
  $ExtractedExecutable = Get-ChildItem -Path $ExtractPath -Filter 'ffmpeg.exe' -File -Recurse | Select-Object -First 1
  $ExtractedLicense = Get-ChildItem -Path $ExtractPath -Filter 'LICENSE.txt' -File -Recurse | Select-Object -First 1
  if (-not $ExtractedExecutable) { throw 'The FFmpeg archive does not contain ffmpeg.exe.' }
  if (-not $ExtractedLicense) { throw 'The FFmpeg archive does not contain LICENSE.txt.' }

  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Copy-Item -LiteralPath $ExtractedExecutable.FullName -Destination $Executable -Force
  Copy-Item -LiteralPath $ExtractedLicense.FullName -Destination $License -Force
  Set-Content -LiteralPath $Marker -Value $Asset.Sha256 -Encoding ascii
  @(
    "FFmpeg from BtbN/FFmpeg-Builds $ReleaseTag for Windows $Architecture"
    $Url
    "SHA-256 (archive): $($Asset.Sha256)"
  ) | Set-Content -LiteralPath (Join-Path $Destination 'SOURCE.txt') -Encoding utf8

  Get-Item -LiteralPath $Executable | Select-Object FullName, Length
} finally {
  if (Test-Path -LiteralPath $TemporaryRoot) {
    Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force
  }
}
