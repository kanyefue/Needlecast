$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$CliScript = Join-Path $ProjectRoot 'cli-windows.ps1'
$RequiredFiles = @('docker-compose.yml', 'Dockerfile', 'server.js', '.env.example', 'capture-agent\capture_agent.py', 'capture-agent\requirements.txt')
foreach ($file in $RequiredFiles) {
    if (-not (Test-Path (Join-Path $ProjectRoot $file))) {
        throw "Missing required project file: $file. Extract the complete Needlecast ZIP before installing."
    }
}

$BinDir = Join-Path $env:LOCALAPPDATA 'Programs\Needlecast\bin'
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

foreach ($commandName in @('needlecast', 'vinybot')) {
    $cmdPath = Join-Path $BinDir "$commandName.cmd"
    $cmdContent = @"
@echo off
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=help"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$CliScript" -ProjectRoot "$ProjectRoot" -Action "%ACTION%"
exit /b %ERRORLEVEL%
"@
    Set-Content -Path $cmdPath -Value $cmdContent -Encoding ASCII
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathItems = @()
if ($userPath) { $pathItems = @($userPath -split ';' | Where-Object { $_.Trim() -ne '' }) }
$alreadyAdded = $false
foreach ($item in $pathItems) {
    if ([string]::Equals($item.TrimEnd('\'), $BinDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        $alreadyAdded = $true
        break
    }
}
if (-not $alreadyAdded) {
    $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $BinDir } else { "$userPath;$BinDir" }
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
}
$env:Path = "$BinDir;$env:Path"

Write-Host ''
Write-Host 'Needlecast command-line shortcuts installed.' -ForegroundColor Green
Write-Host "Project folder: $ProjectRoot"
Write-Host "Commands: $BinDir\vinybot.cmd and $BinDir\needlecast.cmd"
Write-Host ''
Write-Host 'Close this terminal, open a new PowerShell/Terminal window, then run:' -ForegroundColor Cyan
Write-Host '  vinybot start' -ForegroundColor White
Write-Host ''
Write-Host 'This command starts Docker, waits until the dashboard responds, launches the Windows audio-capture agent in the background, and opens the dashboard.'
Write-Host 'The project folder must stay where it is. If you move it, re-run install-windows.ps1 from its new location.'
