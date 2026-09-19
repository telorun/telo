<#
.SYNOPSIS
Install the standalone `telo` executable on Windows.

.DESCRIPTION
Downloads the release archive for this machine and puts one file on PATH.
Nothing is compiled, no package manager is involved, and Node.js is not
required — the binary carries its own runtime.

    irm https://telo.run/install.ps1 | iex

.PARAMETER Version
The version to install. Defaults to the latest release.

.PARAMETER InstallDir
Where to install. Defaults to %LOCALAPPDATA%\Telo\bin, which needs no
administrator rights and is added to the user's PATH.
#>
[CmdletBinding()]
param(
    [string]$Version = $env:TELO_VERSION,
    [string]$InstallDir = $(if ($env:TELO_INSTALL) { $env:TELO_INSTALL } else { Join-Path $env:LOCALAPPDATA 'Telo\bin' })
)

$ErrorActionPreference = 'Stop'
$repo = if ($env:TELO_REPO) { $env:TELO_REPO } else { 'telorun/telo' }

# The release assets are named by target, and only these two exist for Windows.
$target = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'windows-amd64' }
    'ARM64' { 'windows-arm64' }
    default { throw "unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

if (-not $Version) {
    $latest = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
    if ($latest.tag_name -notmatch '^v(.+)$') {
        throw "could not determine the latest version; pass -Version."
    }
    $Version = $Matches[1]
}

$asset = "telo-$Version-$target.zip"
$url = "https://github.com/$repo/releases/download/v$Version/$asset"
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $temp | Out-Null

try {
    Write-Host "downloading $url"
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $temp $asset)

    # The release publishes a checksum beside every archive; checking it turns a
    # truncated or tampered download into a refusal here rather than a confusing
    # failure later.
    try {
        Invoke-WebRequest -Uri "$url.sha256" -OutFile (Join-Path $temp "$asset.sha256")
        $expected = ((Get-Content (Join-Path $temp "$asset.sha256") -Raw) -split '\s+')[0]
        $actual = (Get-FileHash (Join-Path $temp $asset) -Algorithm SHA256).Hash
        if ($actual -ne $expected) {
            throw "checksum mismatch for ${asset}: expected $expected, got $actual"
        }
    }
    catch [System.Net.WebException] {
        Write-Warning "no published checksum for $asset; continuing"
    }

    Expand-Archive -Path (Join-Path $temp $asset) -DestinationPath $temp -Force

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item -Path (Join-Path $temp 'telo.exe') -Destination (Join-Path $InstallDir 'telo.exe') -Force

    # PATH is read back from the registry rather than from this process, whose
    # copy carries whatever the session inherited; writing that back would
    # persist a snapshot of the current shell.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
        Write-Host "added $InstallDir to your PATH — open a new terminal to use it."
    }

    Write-Host "installed telo $Version to $InstallDir\telo.exe"
}
finally {
    Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
