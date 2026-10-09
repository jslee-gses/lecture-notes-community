param(
    [string]$WorkspacePath = (Get-Location).Path,
    [string]$LockPath = (Join-Path $PSScriptRoot 'tools.lock.json')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'This release supports 64-bit Windows only'
}

function Assert-Sha256 {
    param([string]$Path, [string]$Expected)
    if ($Expected -notmatch '^[0-9a-fA-F]{64}$') {
        throw "Invalid checksum in tools.lock.json for $Path"
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "checksum mismatch: $Path"
    }
}

if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
    throw "Tool lock file is missing: $LockPath"
}
$toolLock = Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $WorkspacePath -Force | Out-Null
$workspaceRoot = (Resolve-Path -LiteralPath $WorkspacePath).Path
$cacheDir = Join-Path $workspaceRoot '.lecture-notes\tools'
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null

$denoPath = Join-Path $cacheDir 'deno.exe'
if (Test-Path -LiteralPath $denoPath) {
    Assert-Sha256 -Path $denoPath -Expected $toolLock.deno.exe_sha256
} else {
    $archivePath = Join-Path $cacheDir 'deno.download.zip'
    try {
        Invoke-WebRequest -Uri $toolLock.deno.archive_url -OutFile $archivePath -UseBasicParsing
        Assert-Sha256 -Path $archivePath -Expected $toolLock.deno.archive_sha256
        Expand-Archive -LiteralPath $archivePath -DestinationPath $cacheDir -Force
        if (-not (Test-Path -LiteralPath $denoPath -PathType Leaf)) {
            throw 'Deno archive did not contain deno.exe'
        }
        Assert-Sha256 -Path $denoPath -Expected $toolLock.deno.exe_sha256
    } finally {
        if (Test-Path -LiteralPath $archivePath) {
            Remove-Item -LiteralPath $archivePath -Force
        }
    }
}

$ytDlpPath = Join-Path $cacheDir 'yt-dlp.exe'
if (Test-Path -LiteralPath $ytDlpPath) {
    Assert-Sha256 -Path $ytDlpPath -Expected $toolLock.yt_dlp.sha256
} else {
    $downloadPath = Join-Path $cacheDir 'yt-dlp.download.exe'
    try {
        Invoke-WebRequest -Uri $toolLock.yt_dlp.url -OutFile $downloadPath -UseBasicParsing
        Assert-Sha256 -Path $downloadPath -Expected $toolLock.yt_dlp.sha256
        Copy-Item -LiteralPath $downloadPath -Destination $ytDlpPath -Force
        Assert-Sha256 -Path $ytDlpPath -Expected $toolLock.yt_dlp.sha256
    } finally {
        if (Test-Path -LiteralPath $downloadPath) {
            Remove-Item -LiteralPath $downloadPath -Force
        }
    }
}

@{
    deno = $denoPath
    ytdlp = $ytDlpPath
} | ConvertTo-Json -Compress
