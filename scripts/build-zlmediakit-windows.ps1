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
$OpenSslVersion = '3.6.3'
$OpenSslSha256 = '243a86649cf6f23eeb6a2ff2456e09e5d77dd9018a54d3d96b0c6bdd6ba6c7f1'

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
$OpenSslSourceDir = Join-Path $BuildRoot 'openssl-source'
$OpenSslInstallDir = Join-Path $BuildRoot 'openssl-install'
$CmakeArchitecture = if ($Architecture -eq 'arm64') { 'ARM64' } else { 'x64' }
$OpenSslTarget = if ($Architecture -eq 'arm64') { 'VC-WIN64-CLANGASM-ARM' } else { 'VC-WIN64A' }
$VisualStudioArchitecture = if ($Architecture -eq 'arm64') { 'arm64' } else { 'amd64' }

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

function Get-Sha256Hex {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $Stream = [System.IO.File]::OpenRead($Path)
  try {
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
      $Hash = $Hasher.ComputeHash($Stream)
    } finally {
      $Hasher.Dispose()
    }
  } finally {
    $Stream.Dispose()
  }

  return ([System.BitConverter]::ToString($Hash)).Replace('-', '').ToLowerInvariant()
}

function Import-VisualStudioEnvironment {
  param(
    [Parameter(Mandatory = $true)][string]$TargetArchitecture
  )

  $VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) {
    throw "Visual Studio locator was not found: $VsWhere"
  }

  $InstallationPath = & $VsWhere `
    -latest `
    -products '*' `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath |
    Select-Object -First 1
  if (-not $InstallationPath) {
    throw 'A Visual Studio installation with the C++ toolchain was not found.'
  }

  $VsDevCmd = Join-Path $InstallationPath 'Common7/Tools/VsDevCmd.bat'
  $DevShellCommand = "`"$VsDevCmd`" -no_logo -arch=$TargetArchitecture -host_arch=amd64 && set"
  $EnvironmentLines = & cmd.exe /d /s /c $DevShellCommand
  if ($LASTEXITCODE -ne 0) {
    throw "VsDevCmd.bat failed with exit code $LASTEXITCODE"
  }

  foreach ($Line in $EnvironmentLines) {
    $Parts = $Line -split '=', 2
    if ($Parts.Length -eq 2) {
      [System.Environment]::SetEnvironmentVariable($Parts[0], $Parts[1], 'Process')
    }
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

  $OpenSslArchive = Join-Path $BuildRoot "openssl-$OpenSslVersion.tar.gz"
  $OpenSslUrl = "https://github.com/openssl/openssl/releases/download/openssl-$OpenSslVersion/openssl-$OpenSslVersion.tar.gz"
  Invoke-WebRequest -Uri $OpenSslUrl -OutFile $OpenSslArchive
  $OpenSslActualSha256 = Get-Sha256Hex -Path $OpenSslArchive
  if ($OpenSslActualSha256 -ne $OpenSslSha256) {
    throw "OpenSSL source SHA-256 mismatch: expected $OpenSslSha256, got $OpenSslActualSha256"
  }
  New-Item -ItemType Directory -Path $OpenSslSourceDir -Force | Out-Null
  Invoke-CheckedCommand -Command 'tar.exe' -Arguments @(
    '-xzf', $OpenSslArchive,
    '-C', $OpenSslSourceDir,
    '--strip-components=1'
  )

  Import-VisualStudioEnvironment -TargetArchitecture $VisualStudioArchitecture
  $OpenSslPrefix = $OpenSslInstallDir.Replace('\', '/')
  Push-Location $OpenSslSourceDir
  try {
    Invoke-CheckedCommand -Command 'perl.exe' -Arguments @(
      'Configure',
      $OpenSslTarget,
      'no-shared',
      'no-tests',
      'no-docs',
      'no-asm',
      "--prefix=$OpenSslPrefix",
      "--openssldir=$OpenSslPrefix/ssl"
    )
    Invoke-CheckedCommand -Command 'nmake.exe' -Arguments @('/NOLOGO')
    Invoke-CheckedCommand -Command 'nmake.exe' -Arguments @('/NOLOGO', 'install_sw')
  } finally {
    Pop-Location
  }

  $OpenSslSslLibrary = Get-ChildItem -Path $OpenSslInstallDir -Filter 'libssl*.lib' -File -Recurse |
    Select-Object -First 1
  $OpenSslCryptoLibrary = Get-ChildItem -Path $OpenSslInstallDir -Filter 'libcrypto*.lib' -File -Recurse |
    Select-Object -First 1
  if (-not $OpenSslSslLibrary -or -not $OpenSslCryptoLibrary) {
    throw 'The OpenSSL build completed but the static libraries were not found.'
  }

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
    '-DLIBSRTP_TEST_APPS=OFF'
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
    '-DOPENSSL_MSVC_STATIC_RT=TRUE',
    "-DOPENSSL_ROOT_DIR=$OpenSslInstallDir",
    "-DOPENSSL_INCLUDE_DIR=$(Join-Path $OpenSslInstallDir 'include')",
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
