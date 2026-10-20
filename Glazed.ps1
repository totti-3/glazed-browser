# Glazed launcher: on first run it downloads the official Electron (Chromium) runtime
# from GitHub, verifies its SHA-256 checksum, then starts Glazed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = $PSScriptRoot
$rt   = Join-Path $root 'runtime'
$exe  = Join-Path $rt 'Glazed.exe'
$ver  = '33.2.0'
$sha  = '9f2cb12d87761a5e0bbd69960507172223132cbbfc32737dc4ed9803ae971288'
$url  = "https://github.com/electron/electron/releases/download/v$ver/electron-v$ver-win32-x64.zip"

if (-not (Test-Path $exe)) {
    Write-Host 'First start: downloading the Chromium runtime (about 115 MB, one time only)...'
    $zip = Join-Path $env:TEMP "electron-v$ver-win32-x64.zip"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $sha) { Remove-Item $zip; throw "Checksum mismatch - download corrupted. Please try again." }
    if (Test-Path $rt) { Remove-Item $rt -Recurse -ErrorAction SilentlyContinue }
    Expand-Archive -Path $zip -DestinationPath $rt
    Remove-Item $zip -ErrorAction SilentlyContinue
    Rename-Item (Join-Path $rt 'electron.exe') 'Glazed.exe'
}

# Close leftover invisible Glazed processes from an earlier failed start (they block new starts)
Get-Process -Name Glazed -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -eq 0 } | Stop-Process -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

# Electron only runs an app located in <runtime>\resources\app, so mirror our app folder there on every start
$appDir = Join-Path $root 'app'
$target = Join-Path $rt 'resources\app'
& robocopy $appDir $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if (-not (Test-Path (Join-Path $target 'main.js'))) { throw "Could not copy the app files to $target" }
$log = Join-Path $root 'glazed-start.log'
Remove-Item $log -ErrorAction SilentlyContinue

function Start-Glazed($extra) {
    $argList = @('--enable-logging', ('--log-file="' + $log + '"')) + $extra
    $p = Start-Process -FilePath $exe -ArgumentList $argList -PassThru
    Start-Sleep -Seconds 7
    return $p
}

$p = Start-Glazed @()
if ($p.HasExited) {
    Write-Host "Glazed closed right after start (exit code $($p.ExitCode)). Retrying in safe graphics mode..."
    $p = Start-Glazed @('--disable-gpu')
}
if ($p.HasExited) {
    Write-Host ''
    Write-Host "Glazed could not start (exit code $($p.ExitCode))." -ForegroundColor Red
    Write-Host "Log file: $log"
    $crash = Join-Path $env:APPDATA 'Glazed\crash.log'
    if (Test-Path $crash) { Write-Host '--- crash.log ---'; Get-Content $crash -Tail 15 }
    if (Test-Path $log)   { Write-Host '--- start log ---'; Get-Content $log -Tail 15 }
    exit 1
}
