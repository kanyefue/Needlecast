$ErrorActionPreference = 'Stop'
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$AgentDir = Join-Path $Root 'capture-agent'
$BuildDist = Join-Path $Root 'build\capture-agent-dist'
$BuildWork = Join-Path $Root 'build\capture-agent-work'
$OutputDir = Join-Path $Root 'build-resources\capture-agent'

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw 'Python Launcher (py.exe) was not found. Install Python 3.11 or newer from https://www.python.org/downloads/windows/ and enable the launcher.'
}

Push-Location $AgentDir
try {
  py -3 -m pip install --upgrade pip
  py -3 -m pip install -r requirements.txt pyinstaller
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  py -3 -m PyInstaller --noconfirm --clean --onefile --console `
    --name needlecast-capture-agent `
    --distpath $BuildDist `
    --workpath $BuildWork `
    --collect-all sounddevice `
    --collect-all numpy `
    --collect-all fastapi `
    --collect-all uvicorn `
    --collect-all websockets `
    capture_agent_bootstrap.py
  Copy-Item -Force (Join-Path $BuildDist 'needlecast-capture-agent.exe') (Join-Path $OutputDir 'needlecast-capture-agent.exe')
  Write-Host "Capture agent built: $(Join-Path $OutputDir 'needlecast-capture-agent.exe')" -ForegroundColor Green
} finally {
  Pop-Location
}
