$ErrorActionPreference = 'Stop'

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$AgentDir = Join-Path $Root 'capture-agent'
$BuildDist = Join-Path $Root 'build\capture-agent-dist'
$BuildWork = Join-Path $Root 'build\capture-agent-work'
$OutputDir = Join-Path $Root 'build-resources\capture-agent'

$PythonCommand = Get-Command python -ErrorAction SilentlyContinue

if (-not $PythonCommand) {
  throw 'Python was not found on PATH. Configure actions/setup-python before building the capture agent.'
}

$Python = $PythonCommand.Source
$PythonVersion = (& $Python --version 2>&1 | Out-String).Trim()
$PythonMinor = (& $Python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" | Out-String).Trim()

Write-Host "Capture-agent Python: $PythonVersion"
Write-Host "Python executable: $Python"

if ($LASTEXITCODE -ne 0) {
  throw 'Could not determine the selected Python version.'
}

if ($PythonMinor -notin @('3.11', '3.12', '3.13')) {
  throw "Unsupported Python version $PythonMinor. Use Python 3.12 in the Windows installer workflow."
}

$PythonBits = (& $Python -c "import struct; print(struct.calcsize('P') * 8)" | Out-String).Trim()

if ($PythonBits -ne '64') {
  throw 'The capture-agent build requires 64-bit Python.'
}

Push-Location $AgentDir

try {
  & $Python -m pip install --upgrade pip
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to upgrade pip.'
  }

  & $Python -m pip install --only-binary=numpy -r requirements.txt pyinstaller
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to install capture-agent dependencies.'
  }

  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

  & $Python -m PyInstaller --noconfirm --clean --onefile --console `
    --name needlecast-capture-agent `
    --distpath $BuildDist `
    --workpath $BuildWork `
    --collect-all sounddevice `
    --collect-all numpy `
    --collect-all fastapi `
    --collect-all uvicorn `
    --collect-all websockets `
    capture_agent_bootstrap.py

  if ($LASTEXITCODE -ne 0) {
    throw 'PyInstaller failed to build the capture agent.'
  }

  $BuiltExe = Join-Path $BuildDist 'needlecast-capture-agent.exe'

  if (-not (Test-Path $BuiltExe)) {
    throw "PyInstaller finished without producing the expected file: $BuiltExe"
  }

  Copy-Item -Force $BuiltExe (Join-Path $OutputDir 'needlecast-capture-agent.exe')

  Write-Host "Capture agent built successfully: $(Join-Path $OutputDir 'needlecast-capture-agent.exe')" -ForegroundColor Green
}
finally {
  Pop-Location
}
