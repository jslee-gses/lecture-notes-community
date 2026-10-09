$ErrorActionPreference = 'Stop'
$workspace = Join-Path $env:TEMP ("lecture-bootstrap-test-" + [guid]::NewGuid().ToString('N'))
$cache = Join-Path $workspace '.lecture-notes\tools'
$script = Join-Path $PSScriptRoot '..\tools\bootstrap.ps1'

try {
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $deno = Join-Path $cache 'deno.exe'
    $ytdlp = Join-Path $cache 'yt-dlp.exe'
    [System.IO.File]::WriteAllText($deno, 'deno-test')
    [System.IO.File]::WriteAllText($ytdlp, 'ytdlp-test')
    $lock = @{
        deno = @{
            version = 'test'
            archive_url = 'https://example.invalid/deno.zip'
            archive_sha256 = ('0' * 64)
            exe_sha256 = (Get-FileHash -LiteralPath $deno -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        yt_dlp = @{
            version = 'test'
            url = 'https://example.invalid/yt-dlp.exe'
            sha256 = (Get-FileHash -LiteralPath $ytdlp -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $lockPath = Join-Path $workspace 'test-lock.json'
    $lock | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $lockPath -Encoding UTF8
    $result = & $script -WorkspacePath $workspace -LockPath $lockPath | ConvertFrom-Json
    if ($result.deno -ne $deno -or $result.ytdlp -ne $ytdlp) {
        throw 'Cache reuse returned the wrong paths'
    }
    [System.IO.File]::WriteAllText($deno, 'tampered')
    try {
        & $script -WorkspacePath $workspace -LockPath $lockPath | Out-Null
        throw 'Tampered cache was accepted'
    } catch {
        if ($_.Exception.Message -notmatch 'checksum mismatch') { throw }
    }
    Write-Output 'bootstrap cache reuse and checksum mismatch: passed'
} finally {
    $resolved = [System.IO.Path]::GetFullPath($workspace)
    $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing cleanup outside temporary directory'
    }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
