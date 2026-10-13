# MAX - local server.
# Serves the UI from ..\web and a small JSON API on http://localhost:<port>/ .
# Every request runs in a runspace pool so slow calls (AI, voice) never block the UI.
param([int]$Port = 0, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ServerDir = $PSScriptRoot
. (Join-Path $ServerDir 'handlers.ps1')

$config = Get-MaxConfig
if (-not $Port) { $Port = [int]$config.port }
$BaseUrl = "http://localhost:$Port/"

# Already running? Just bring up a window.
try {
    $ping = Invoke-WebRequest -UseBasicParsing "$($BaseUrl)api/ping" -TimeoutSec 3
    if ($ping.Content -match '"max"') {
        if (-not $NoBrowser) { [void](Open-MaxWindow $BaseUrl $config) }
        return
    }
} catch { }
# An older Max server that doesn't answer is stuck: replace it.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like "*$ServerDir*server.ps1*" } |
    ForEach-Object {
        Write-MaxLog "Replacing unresponsive Max server (pid $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800   # let Windows release its port and DLL
    }

# Native helpers (voice, volume, keys). Compiled once and cached next to the data.
$csPath = Join-Path $ServerDir 'MaxNative.cs'
$dllPath = Join-Path $MaxDataDir 'MaxNative.dll'
if (-not (Test-Path $dllPath) -or (Get-Item $dllPath).LastWriteTime -lt (Get-Item $csPath).LastWriteTime) {
    Remove-Item $dllPath -ErrorAction SilentlyContinue
    Add-Type -TypeDefinition (Get-Content -Raw $csPath) -Language CSharp -OutputAssembly $dllPath -OutputType Library
}
Add-Type -Path $dllPath
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[void][MaxKeys]::SetProcessDPIAware()
[MaxTts]::StartKeeper()

$shared = [hashtable]::Synchronized(@{
    Quit        = $false
    LastRequest = [DateTime]::UtcNow
    Models      = [hashtable]::Synchronized(@{})
    Tts         = [hashtable]::Synchronized(@{})
    Started     = [DateTime]::Now
})

$iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
$pool = [RunspaceFactory]::CreateRunspacePool(1, 16, $iss, $Host)
$pool.ApartmentState = 'STA'   # clipboard + screenshot need STA
$pool.ThreadOptions = 'ReuseThread'
$pool.Open()

$handlerPath = Join-Path $ServerDir 'handlers.ps1'
$worker = @'
param($ctx, $shared, $handlerPath)
if (-not (Get-Command Invoke-MaxRequest -ErrorAction SilentlyContinue)) { . $handlerPath }
Invoke-MaxRequest $ctx $shared
'@

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($BaseUrl)
$listener.Start()
Write-MaxLog "Max server listening on $BaseUrl"
try { Write-Host "MAX is running on $BaseUrl  (close the Max window to stop)" -ForegroundColor DarkYellow } catch { }
[MaxWatchdog]::LogPath = Join-Path $MaxDataDir 'server.log'
[MaxWatchdog]::Start(45)

$browser = $null
if (-not $NoBrowser) { $browser = Open-MaxWindow $BaseUrl $config }
$browserStarted = Get-Date

$jobs = [System.Collections.Generic.List[object]]::new()
try {
    while ($listener.IsListening -and -not $shared.Quit) {
        [MaxWatchdog]::Beat()
        $pending = $listener.GetContextAsync()
        while (-not $pending.Wait(500)) {
            [MaxWatchdog]::Beat()
            for ($i = $jobs.Count - 1; $i -ge 0; $i--) {
                $j = $jobs[$i]
                if ($j.Handle.IsCompleted) {
                    try { [void]$j.PS.EndInvoke($j.Handle) } catch { Write-MaxLog "worker: $($_.Exception.Message)" }
                    $j.PS.Dispose()
                    $jobs.RemoveAt($i)
                }
            }
            if ($shared.Quit) { break }
            # Stop when the Max window is gone: either our browser process exited,
            # or (if we could not track it) the page stopped polling for a while.
            $idle = ([DateTime]::UtcNow - $shared.LastRequest).TotalSeconds
            $browserAlive = $browser -and -not $browser.HasExited
            if (-not $browserAlive -and ((Get-Date) - $browserStarted).TotalSeconds -gt 20 -and $idle -gt 90) {
                Write-MaxLog 'No window for a while - shutting down.'
                $shared.Quit = $true
            }
        }
        if ($shared.Quit) { break }
        $ctx = $pending.Result
        $ps = [PowerShell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript($worker).AddArgument($ctx).AddArgument($shared).AddArgument($handlerPath)
        $jobs.Add([pscustomobject]@{ PS = $ps; Handle = $ps.BeginInvoke() })
    }
} finally {
    Start-Sleep -Milliseconds 300   # let the last response (e.g. /api/quit) flush
    try { $listener.Stop(); $listener.Close() } catch { }
    # don't wait forever for a stuck worker
    try { [void]$pool.BeginClose($null, $null).AsyncWaitHandle.WaitOne(3000) } catch { }
    Write-MaxLog 'Max server stopped.'
    [Environment]::Exit(0)
}
