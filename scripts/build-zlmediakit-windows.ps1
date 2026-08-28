[CmdletBinding()]
param(
  [ValidateSet('x64', 'arm64')]
  [string]$Architecture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ZlmCommit = 'fdaec2604d4091886158cbaca39dca2b5e5d25db'
$ZlToolkitCommit = 'b311fdef4c9aabb94d33579e0a3810e6db7810c2'
$MediaServerCommit = '21c4451ff2e4c4bb1c817e606c8b4e5deac1e719'
$JsonCppCommit = 'ca98c98457b1163cca1f7d8db62827c115fec6d1'
$LibSrtpCommit = 'fd08747fa6800b321d53e15feb34da12dc697dee'

if (-not $Architecture) {
  $Architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BuildRoot = Join-Path ([System.IO.Path]::GetTempPath()) "dji-zlm-build-$([System.Guid]::NewGuid().ToString('N'))"
$SourceDir = Join-Path $BuildRoot 'source'
$BuildDir = Join-Path $BuildRoot 'build'
$SrtpSourceDir = Join-Path $BuildRoot 'libsrtp-source'
$SrtpBuildDir = Join-Path $BuildRoot 'libsrtp-build'
$SrtpInstallDir = Join-Path $BuildRoot 'libsrtp-install'
$CmakeArchitecture = if ($Architecture -eq 'arm64') { 'ARM64' } else { 'x64' }

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

function Expand-GitHubArchive {
  param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Commit,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  $ArchiveName = $Repository.Replace('/', '-') + '.tar.gz'
  $ArchivePath = Join-Path $BuildRoot $ArchiveName
  $Headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'dji-cloud-studio-zlmediakit-builder'
  }
  if ($env:GITHUB_TOKEN) {
    $Headers.Authorization = "Bearer $($env:GITHUB_TOKEN)"
  }

  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Invoke-WebRequest -Uri "https://api.github.com/repos/$Repository/tarball/$Commit" -Headers $Headers -OutFile $ArchivePath
  Invoke-CheckedCommand -Command 'tar.exe' -Arguments @(
    '-xzf', $ArchivePath,
    '-C', $Destination,
    '--strip-components=1'
  )
}

New-Item -ItemType Directory -Path $SourceDir -Force | Out-Null

try {
  Expand-GitHubArchive -Repository 'ZLMediaKit/ZLMediaKit' -Commit $ZlmCommit -Destination $SourceDir
  Expand-GitHubArchive -Repository 'ZLMediaKit/ZLToolKit' -Commit $ZlToolkitCommit -Destination (Join-Path $SourceDir '3rdpart/ZLToolKit')
  Expand-GitHubArchive -Repository 'ireader/media-server' -Commit $MediaServerCommit -Destination (Join-Path $SourceDir '3rdpart/media-server')
  Expand-GitHubArchive -Repository 'open-source-parsers/jsoncpp' -Commit $JsonCppCommit -Destination (Join-Path $SourceDir '3rdpart/jsoncpp')
  Expand-GitHubArchive -Repository 'cisco/libsrtp' -Commit $LibSrtpCommit -Destination $SrtpSourceDir

  Invoke-CheckedCommand -Command 'cmake.exe' -Arguments @(
    '-S', $SrtpSourceDir,
    '-B', $SrtpBuildDir,
    '-A', $CmakeArchitecture,
    '-DCMAKE_BUILD_TYPE=Release',
    "-DCMAKE_INSTALL_PREFIX=$SrtpInstallDir",
    '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DENABLE_OPENSSL=OFF',
    '-DTEST_APPS=OFF'
  )
  Invoke-CheckedCommand -Command 'cmake.exe' -Arguments @(
    '--build', $SrtpBuildDir,
    '--target', 'install',
    '--config', 'Release',
    '--parallel'
  )

  Invoke-CheckedCommand -Command 'cmake.exe' -Arguments @(
    '-S', $SourceDir,
    '-B', $BuildDir,
    '-A', $CmakeArchitecture,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
    '-DENABLE_API=OFF',
    '-DENABLE_FFMPEG=OFF',
    '-DENABLE_OPENSSL=ON',
    '-DOPENSSL_USE_STATIC_LIBS=TRUE',
    "-DSRTP_PREFIX=$SrtpInstallDir",
    '-DENABLE_MSVC_MT=ON',
    '-DENABLE_WEBRTC=ON',
    '-DENABLE_SRT=OFF',
    '-DENABLE_TESTS=OFF',
    '-DENABLE_OBJCOPY=OFF',
    '-DDISABLE_REPORT=ON'
  )
  $WebRtcDefinition = Get-ChildItem -Path $BuildDir -Recurse -File -Filter '*.vcxproj' |
    Select-String -Pattern 'ENABLE_WEBRTC' -Quiet
  if (-not $WebRtcDefinition) {
    throw 'ZLMediaKit configuration did not enable WebRTC; verify OpenSSL and libsrtp'
  }
  Invoke-CheckedCommand -Command 'cmake.exe' -Arguments @(
    '--build', $BuildDir,
    '--target', 'MediaServer',
    '--config', 'Release',
    '--parallel'
  )

  $SearchRoots = @($BuildDir, (Join-Path $SourceDir 'release')) | Where-Object { Test-Path -LiteralPath $_ }
  $MediaServer = Get-ChildItem -Path $SearchRoots -Filter 'MediaServer.exe' -Recurse -File |
    Where-Object { $_.FullName -match '[\\/]Release[\\/]' } |
    Select-Object -First 1
  if (-not $MediaServer) {
    throw 'The ZLMediaKit build completed but MediaServer.exe was not found.'
  }

  $Destination = Join-Path $ProjectRoot "vendor/zlmediakit/win32-$Architecture"
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Copy-Item -Path $MediaServer.FullName -Destination (Join-Path $Destination 'MediaServer.exe') -Force
  Copy-Item -Path (Join-Path $SourceDir 'LICENSE') -Destination (Join-Path $ProjectRoot 'vendor/zlmediakit/LICENSE') -Force
  Write-Host "Built ZLMediaKit $ZlmCommit for Windows $Architecture`: $Destination/MediaServer.exe"
}
finally {
  if (Test-Path -LiteralPath $BuildRoot) {
    Remove-Item -LiteralPath $BuildRoot -Recurse -Force
  }
}
