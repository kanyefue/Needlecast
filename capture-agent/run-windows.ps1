$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'

if (-not (Test-Path $VenvPython)) {
    Write-Host 'Creating the local Python environment...'
    py -3 -m venv (Join-Path $ProjectRoot '.venv')
}

Write-Host 'Installing/updating the small audio-capture dependencies...'
& $VenvPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements.txt')

Write-Host ''
Write-Host 'Starting the host audio capture agent at http://127.0.0.1:8766'
Write-Host 'Keep this window open while broadcasting.'
Set-Location $PSScriptRoot
& $VenvPython -m uvicorn capture_agent:app --host 127.0.0.1 --port 8766 --log-level info
