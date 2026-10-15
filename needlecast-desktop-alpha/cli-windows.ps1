param(
    [string]$ProjectRoot = $PSScriptRoot,
    [Parameter(Position = 0)]
    [string]$Action = 'help'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$DashboardUrl = 'http://127.0.0.1:3000'
$CaptureUrl = 'http://127.0.0.1:8766'
$AgentDir = Join-Path $ProjectRoot 'capture-agent'
$VenvDir = Join-Path $ProjectRoot '.venv'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$Requirements = Join-Path $AgentDir 'requirements.txt'
$PidFile = Join-Path $env:LOCALAPPDATA 'Needlecast\capture-agent.pid'
$LogDir = Join-Path $env:LOCALAPPDATA 'Needlecast\logs'
$AgentStdout = Join-Path $LogDir 'capture-agent.log'
$AgentStderr = Join-Path $LogDir 'capture-agent-error.log'

function Write-Section([string]$Message) {
    Write-Host "`n== $Message ==" -ForegroundColor Cyan
}

function Get-JsonEndpoint([string]$Url) {
    try {
        return Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 3
    } catch {
        return $null
    }
}

function Invoke-PostBestEffort([string]$Url) {
    try { Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec 3 | Out-Null } catch { }
}

function Invoke-ExternalCommand([string]$FilePath, [string[]]$Arguments) {
    # Keep native stderr (Docker/Python/pip diagnostic output) from becoming a
    # terminating PowerShell error under Windows PowerShell 5.1.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $FilePath @Arguments 2>&1 | Out-Host
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Invoke-Compose([string[]]$ComposeArgs) {
    Push-Location $ProjectRoot
    try {
        $composeExitCode = Invoke-ExternalCommand -FilePath 'docker' -Arguments (@('compose') + $ComposeArgs)
        if ($composeExitCode -ne 0) {
            throw "docker compose $($ComposeArgs -join ' ') failed with exit code $composeExitCode."
        }
    } finally {
        Pop-Location
    }
}

function Wait-ForDashboard {
    Write-Host 'Waiting for the dashboard container to become ready...' -ForegroundColor DarkGray
    for ($i = 0; $i -lt 60; $i++) {
        $health = Get-JsonEndpoint "$DashboardUrl/api/health"
        if ($health -and $health.ok) { return $health }
        Start-Sleep -Seconds 2
    }

    Write-Host 'The dashboard did not become ready. Recent container logs:' -ForegroundColor Yellow
    Push-Location $ProjectRoot
    try { [void](Invoke-ExternalCommand -FilePath 'docker' -Arguments @('compose', 'logs', '--tail=60')) } finally { Pop-Location }
    throw 'Timed out waiting for the dashboard. Review the logs above, then run: vinybot start'
}

function Ensure-PythonEnvironment {
    if (-not (Test-Path $VenvPython)) {
        Write-Host 'Creating the local Python environment...' -ForegroundColor DarkGray
        $pyLauncher = Get-Command 'py' -ErrorAction SilentlyContinue
        if ($pyLauncher) {
            $venvExitCode = Invoke-ExternalCommand -FilePath 'py' -Arguments @('-3', '-m', 'venv', $VenvDir)
        } else {
            $pythonCommand = Get-Command 'python' -ErrorAction SilentlyContinue
            if (-not $pythonCommand) {
                throw 'Python 3 is required for audio capture. Install Python 3.10+ from https://www.python.org/downloads/windows/ and enable the Python launcher, then retry.'
            }
            $venvExitCode = Invoke-ExternalCommand -FilePath 'python' -Arguments @('-m', 'venv', $VenvDir)
        }
        if ($venvExitCode -ne 0 -or -not (Test-Path $VenvPython)) {
            throw 'Could not create the Python environment. Install Python 3.10+ and try again.'
        }
    }

    $requirementsHash = (Get-FileHash -Path $Requirements -Algorithm SHA256).Hash
    $hashFile = Join-Path $VenvDir '.needlecast-requirements.sha256'
    $installedHash = if (Test-Path $hashFile) { (Get-Content $hashFile -Raw).Trim() } else { '' }
    if ($installedHash -ne $requirementsHash) {
        Write-Host 'Installing audio-capture dependencies (first run or requirements changed)...' -ForegroundColor DarkGray
        $pipExitCode = Invoke-ExternalCommand -FilePath $VenvPython -Arguments @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', $Requirements)
        if ($pipExitCode -ne 0) {
            throw 'Installing audio dependencies failed. Check your internet connection and the Python/pip error above.'
        }
        Set-Content -Path $hashFile -Value $requirementsHash -Encoding ASCII
    }
}

function Ensure-CaptureAgent {
    $existing = Get-JsonEndpoint "$CaptureUrl/api/health"
    if ($existing -and $existing.service -eq 'host-capture-agent') {
        Write-Host 'Audio-capture agent is already running.' -ForegroundColor Green
        return
    }

    Ensure-PythonEnvironment
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    if (Test-Path $AgentStdout) { Remove-Item $AgentStdout -Force -ErrorAction SilentlyContinue }
    if (Test-Path $AgentStderr) { Remove-Item $AgentStderr -Force -ErrorAction SilentlyContinue }

    Write-Host 'Starting the audio-capture agent in the background...' -ForegroundColor DarkGray
    $agent = Start-Process -FilePath $VenvPython `
        -ArgumentList @('-m', 'uvicorn', 'capture_agent:app', '--host', '127.0.0.1', '--port', '8766', '--log-level', 'info') `
        -WorkingDirectory $AgentDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $AgentStdout `
        -RedirectStandardError $AgentStderr `
        -PassThru

    Set-Content -Path $PidFile -Value $agent.Id -Encoding ASCII
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        if ($agent.HasExited) {
            $agent.Refresh()
            $tail = ''
            if (Test-Path $AgentStderr) { $tail = (Get-Content $AgentStderr -Tail 25 -ErrorAction SilentlyContinue) -join "`n" }
            throw "The audio-capture agent exited during startup. Logs: $AgentStderr`n$tail"
        }
        $health = Get-JsonEndpoint "$CaptureUrl/api/health"
        if ($health -and $health.service -eq 'host-capture-agent') {
            Write-Host 'Audio-capture agent is ready.' -ForegroundColor Green
            return
        }
    }

    throw "Timed out waiting for the audio-capture agent. Check $AgentStdout and $AgentStderr."
}

function Start-Needlecast {
    if (-not (Test-Path (Join-Path $ProjectRoot 'docker-compose.yml'))) {
        throw "Project files were not found at '$ProjectRoot'. Re-run install-windows.ps1 from the extracted project folder."
    }
    if (-not (Test-Path (Join-Path $ProjectRoot '.env'))) {
        throw "The .env file is missing from $ProjectRoot. Copy .env.example to .env and fill in DISCORD_TOKEN and GUILD_ID."
    }
    if (-not (Get-Command 'docker' -ErrorAction SilentlyContinue)) {
        throw 'Docker was not found. Install and start Docker Desktop, then retry.'
    }
    if (-not (Test-Path $Requirements)) {
        throw "Audio-agent requirements were not found at $Requirements."
    }

    Write-Section 'Starting Docker app and Discord bot'
    $previousPreference = $ErrorActionPreference
    try { $ErrorActionPreference = 'Continue'; & docker info *> $null; $dockerInfoExitCode = $LASTEXITCODE } finally { $ErrorActionPreference = $previousPreference }
    if ($dockerInfoExitCode -ne 0) { throw 'Docker Desktop is installed but not running. Start Docker Desktop and run vinybot start again.' }
    Invoke-Compose @('up', '--build', '-d')

    Write-Section 'Starting host audio capture'
    $health = Wait-ForDashboard
    Ensure-CaptureAgent

    $status = Get-JsonEndpoint "$DashboardUrl/api/status"
    if ($status -and -not $status.botReady) {
        Write-Host 'The web app is running, but the Discord bot is not ready yet. Check your bot token, server ID, and container logs if it does not become ready shortly.' -ForegroundColor Yellow
    }

    Write-Section 'Needlecast is running'
    Write-Host "Dashboard: $DashboardUrl" -ForegroundColor Green
    Write-Host 'Choose your input and Discord voice channel, then click Start broadcast.'
    Write-Host "Capture-agent logs: $AgentStdout"
    try { Start-Process $DashboardUrl } catch { }
}

function Stop-CaptureAgent {
    Invoke-PostBestEffort "$DashboardUrl/api/stream/stop"
    Invoke-PostBestEffort "$CaptureUrl/api/stop"

    if (Test-Path $PidFile) {
        $pidText = (Get-Content $PidFile -Raw).Trim()
        $processId = 0
        if ([int]::TryParse($pidText, [ref]$processId)) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -match '^python(w)?\.exe$' -and $proc.CommandLine -match 'uvicorn' -and $proc.CommandLine -match 'capture_agent:app') {
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                Write-Host 'Stopped the audio-capture agent.' -ForegroundColor Green
            }
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    } else {
        $health = Get-JsonEndpoint "$CaptureUrl/api/health"
        if ($health -and $health.service -eq 'host-capture-agent') {
            Write-Host 'Capture agent is responding but its PID file is missing. Stop it from Task Manager or restart Windows before starting another instance.' -ForegroundColor Yellow
        }
    }
}

function Stop-Needlecast {
    Write-Section 'Stopping Needlecast'
    Stop-CaptureAgent
    if (Get-Command 'docker' -ErrorAction SilentlyContinue) {
        Push-Location $ProjectRoot
        try {
            $downExitCode = Invoke-ExternalCommand -FilePath 'docker' -Arguments @('compose', 'down')
            if ($downExitCode -ne 0) { Write-Host 'Docker Compose could not fully stop the app. Check Docker Desktop.' -ForegroundColor Yellow }
        } finally { Pop-Location }
    }
    Write-Host 'Needlecast stopped.' -ForegroundColor Green
}

function Show-Status {
    Write-Section 'Docker containers'
    if (Get-Command 'docker' -ErrorAction SilentlyContinue) {
        Push-Location $ProjectRoot
        try { [void](Invoke-ExternalCommand -FilePath 'docker' -Arguments @('compose', 'ps')) } finally { Pop-Location }
    } else { Write-Host 'Docker CLI not found.' -ForegroundColor Yellow }

    Write-Section 'Services'
    $dashboard = Get-JsonEndpoint "$DashboardUrl/api/status"
    if ($dashboard) {
        Write-Host "Dashboard: online ($DashboardUrl)"
        Write-Host "Discord bot: $(if ($dashboard.botReady) { 'ready' } else { 'not ready' })"
        Write-Host "Discord voice: $(if ($dashboard.connected) { 'connected' } else { 'not connected' })"
    } else { Write-Host 'Dashboard: offline' -ForegroundColor Yellow }

    $capture = Get-JsonEndpoint "$CaptureUrl/api/status"
    if ($capture) {
        Write-Host "Capture agent: online"
        Write-Host "Audio capture: $(if ($capture.streaming) { 'running' } else { 'idle (ready)' })"
        if ($capture.selectedDeviceName) { Write-Host "Input: $($capture.selectedDeviceName)" }
    } else { Write-Host 'Capture agent: offline' -ForegroundColor Yellow }
}

try {
    switch ($Action.ToLowerInvariant()) {
        'start'   { Start-Needlecast }
        'stop'    { Stop-Needlecast }
        'restart' { Stop-Needlecast; Start-Needlecast }
        'status'  { Show-Status }
        'open'    { Start-Process $DashboardUrl }
        'logs'    {
            Write-Host "Following Docker logs (Ctrl+C to exit). Capture logs: $AgentStdout"
            Push-Location $ProjectRoot
            try { [void](Invoke-ExternalCommand -FilePath 'docker' -Arguments @('compose', 'logs', '-f', '--tail=100')) } finally { Pop-Location }
        }
        'agent-logs' {
            if (Test-Path $AgentStdout) { Get-Content $AgentStdout -Tail 100 -Wait }
            else { Write-Host "No capture log found yet at $AgentStdout" }
        }
        'help' { }
        default { Write-Host "Unknown command: $Action" -ForegroundColor Yellow }
    }
} catch {
    Write-Host "`nNeedlecast error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

if ($Action -in @('help') -or $Action.ToLowerInvariant() -notin @('start', 'stop', 'restart', 'status', 'open', 'logs', 'agent-logs')) {
    Write-Host @'
Needlecast / Vinybot commands
  vinybot start       Start Docker, wait for the dashboard, start audio capture, open the UI
  vinybot stop        Stop broadcasting, stop the capture agent, and shut Docker down
  vinybot restart     Restart both services
  vinybot status      Show Docker, dashboard, bot, and capture-agent status
  vinybot open        Open the dashboard in your browser
  vinybot logs        Follow Docker logs (Ctrl+C exits)
  vinybot agent-logs  Follow audio-capture-agent logs (Ctrl+C exits)

The same commands are available through: needlecast <command>
'@
}
