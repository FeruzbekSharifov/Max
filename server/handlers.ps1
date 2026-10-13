# MAX - request handlers, config, memory, AI providers and Windows tools.
# Dot-sourced by server.ps1 and by every worker runspace.

$MaxRoot = Split-Path -Parent $PSScriptRoot
$MaxDataDir = Join-Path $MaxRoot 'data'
$MaxWebDir = Join-Path $MaxRoot 'web'
if (-not (Test-Path $MaxDataDir)) { New-Item -ItemType Directory -Force $MaxDataDir | Out-Null }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$MaxDefaultConfig = [ordered]@{
    port              = 8765
    user_name         = ''
    address_as        = 'boss'
    provider          = 'auto'        # auto | groq | gemini | openrouter | ollama | offline
    groq_key          = ''
    gemini_key        = ''
    openrouter_key    = ''
    model             = ''            # empty = choose automatically
    ollama_url        = 'http://localhost:11434'
    city              = ''            # weather location; empty = detect from IP
    wake_word         = $true
    use_claude_memory = $true
    browser           = 'auto'        # auto | chrome | edge
}
$MaxSecretKeys = @('groq_key', 'gemini_key', 'openrouter_key')

# ------------------------------------------------------------------ basics

function Write-MaxLog([string]$msg) {
    try {
        $f = Join-Path $MaxDataDir 'server.log'
        if ((Test-Path $f) -and (Get-Item $f).Length -gt 1MB) { Remove-Item $f -ErrorAction SilentlyContinue }
        Add-Content -Path $f -Value ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $msg) -Encoding UTF8
    } catch { }
}

function Read-MaxJson([string]$name, $default) {
    $f = Join-Path $MaxDataDir $name
    if (-not (Test-Path $f)) { return $default }
    try {
        $raw = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)
        if (-not $raw.Trim()) { return $default }
        return ($raw | ConvertFrom-Json)
    } catch { return $default }
}

function Write-MaxJson([string]$name, $obj) {
    $f = Join-Path $MaxDataDir $name
    $json = ConvertTo-Json -InputObject $obj -Depth 12
    [IO.File]::WriteAllText($f, $json, (New-Object Text.UTF8Encoding $false))
}

function Get-MaxConfig {
    $cfg = [ordered]@{}
    foreach ($k in $MaxDefaultConfig.Keys) { $cfg[$k] = $MaxDefaultConfig[$k] }
    $saved = Read-MaxJson 'config.json' $null
    if ($saved) {
        foreach ($p in $saved.PSObject.Properties) { if ($cfg.Contains($p.Name)) { $cfg[$p.Name] = $p.Value } }
    }
    return $cfg
}

function Save-MaxConfig($changes) {
    $cfg = Get-MaxConfig
    foreach ($p in $changes.PSObject.Properties) {
        if (-not $cfg.Contains($p.Name)) { continue }
        if ($MaxSecretKeys -contains $p.Name) {
            $v = [string]$p.Value
            if ($v -eq '__clear__') { $cfg[$p.Name] = '' }
            elseif ($v.Trim() -and $v -notmatch [char]0x2022) { $cfg[$p.Name] = $v.Trim() }
            continue
        }
        $cfg[$p.Name] = $p.Value
    }
    Write-MaxJson 'config.json' $cfg
}

function Get-MaxPublicConfig {
    $cfg = Get-MaxConfig
    $out = [ordered]@{}
    foreach ($k in $cfg.Keys) {
        if ($MaxSecretKeys -contains $k) {
            $v = [string]$cfg[$k]
            $out[$k] = if ($v.Length -gt 4) { ([string][char]0x2022 * 6) + $v.Substring($v.Length - 4) } else { '' }
        } else { $out[$k] = $cfg[$k] }
    }
    $out['active_provider'] = Resolve-MaxProvider $cfg
    return $out
}

function Invoke-MaxHttp {
    param([string]$Url, [string]$Method = 'GET', [hashtable]$Headers = @{}, $Body = $null, [int]$TimeoutSec = 30)
    if ($null -ne $Body -and $Body -isnot [string]) { $Body = ConvertTo-Json -InputObject $Body -Depth 20 -Compress; if (-not $Headers.ContainsKey('Content-Type')) { $Headers['Content-Type'] = 'application/json' } }
    # A reused keep-alive connection that the server already closed fails instantly; one fresh retry fixes it.
    for ($attempt = 0; ; $attempt++) {
        try { return Invoke-MaxHttpOnce $Url $Method $Headers $Body $TimeoutSec ($attempt -gt 0) }
        catch {
            $e = $_.Exception
            while ($e -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
            $transient = $e -and $e.Status -in @('KeepAliveFailure', 'ConnectionClosed', 'ReceiveFailure', 'SendFailure', 'PipelineFailure', 'ConnectFailure', 'NameResolutionFailure')
            if ($attempt -ge 1 -or -not $transient) { throw }
            Write-MaxLog "HTTP retry after $($e.Status): $Url"
            Start-Sleep -Milliseconds 200
        }
    }
}

function Invoke-MaxHttpOnce([string]$Url, [string]$Method, [hashtable]$Headers, $Body, [int]$TimeoutSec, [bool]$NoKeepAlive) {
    $req = [Net.HttpWebRequest]::Create($Url)
    if ($NoKeepAlive) { $req.KeepAlive = $false }
    $req.Method = $Method
    $req.Timeout = $TimeoutSec * 1000
    $req.ReadWriteTimeout = $TimeoutSec * 1000
    $req.UserAgent = 'Max/1.0 (Windows desktop assistant)'
    # gzip only: .NET Framework's Deflate decoder chokes on the zlib-wrapped "deflate" many servers send.
    $req.AutomaticDecompression = [Net.DecompressionMethods]::GZip
    foreach ($k in $Headers.Keys) {
        switch ($k) {
            'Content-Type' { $req.ContentType = $Headers[$k] }
            'Accept' { $req.Accept = $Headers[$k] }
            'User-Agent' { $req.UserAgent = $Headers[$k] }
            default { $req.Headers[$k] = $Headers[$k] }
        }
    }
    if ($null -ne $Body) {
        if ($Body -isnot [string]) {
            $Body = ConvertTo-Json -InputObject $Body -Depth 20 -Compress
            if (-not $req.ContentType) { $req.ContentType = 'application/json' }
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
        $req.ContentLength = $bytes.Length
        $s = $req.GetRequestStream()
        $s.Write($bytes, 0, $bytes.Length)
        $s.Close()
    }
    $resp = $null
    try { $resp = $req.GetResponse() }
    catch {
        $e = $_.Exception
        while ($e -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
        if ($e -and $e.Response) { $resp = $e.Response } else { throw }
    }
    try {
        $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        return [pscustomobject]@{ Status = [int]$resp.StatusCode; Text = $text }
    } finally { $resp.Close() }
}

function Get-MaxErrorMessage($httpResult) {
    try {
        $j = $httpResult.Text | ConvertFrom-Json
        if ($j.error.message) { return [string]$j.error.message }
        if ($j.error -is [string]) { return $j.error }
    } catch { }
    $t = [string]$httpResult.Text
    if ($t.Length -gt 300) { $t = $t.Substring(0, 300) }
    return "HTTP $($httpResult.Status): $t"
}

# ------------------------------------------------------------------ HTTP plumbing

function Send-MaxBytes($res, [byte[]]$bytes, [string]$type) {
    $res.ContentType = $type
    $res.Headers['Cache-Control'] = 'no-store'
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-MaxJson($res, $obj) {
    $json = ConvertTo-Json -InputObject $obj -Depth 12 -Compress
    Send-MaxBytes $res ([Text.Encoding]::UTF8.GetBytes($json)) 'application/json; charset=utf-8'
}

$MaxMime = @{
    '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'
    '.json' = 'application/json'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'
    '.ico' = 'image/x-icon'; '.mp3' = 'audio/mpeg'; '.woff2' = 'font/woff2'
}

function Send-MaxStatic($res, [string]$path) {
    if ($path -eq '/' -or -not $path) { $path = '/index.html' }
    $rel = [Uri]::UnescapeDataString($path.TrimStart('/')).Replace('/', '\')
    $full = [IO.Path]::GetFullPath((Join-Path $MaxWebDir $rel))
    if (-not $full.StartsWith($MaxWebDir, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $full -PathType Leaf)) {
        $res.StatusCode = 404
        Send-MaxBytes $res ([Text.Encoding]::UTF8.GetBytes('Not found')) 'text/plain'
        return
    }
    $ext = [IO.Path]::GetExtension($full).ToLower()
    $type = if ($MaxMime.ContainsKey($ext)) { $MaxMime[$ext] } else { 'application/octet-stream' }
    Send-MaxBytes $res ([IO.File]::ReadAllBytes($full)) $type
}

function Invoke-MaxRequest($ctx, $shared) {
    $req = $ctx.Request
    $res = $ctx.Response
    $shared.LastRequest = [DateTime]::UtcNow
    try {
        $path = $req.Url.AbsolutePath
        if (-not $path.StartsWith('/api/')) { Send-MaxStatic $res $path; return }
        if ($path -eq '/api/tts/stream') { Send-MaxSpeechStream $req $res $shared; return }

        $body = $null
        if ($req.HasEntityBody) {
            $sr = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
            $raw = $sr.ReadToEnd()
            if ($raw.Trim()) { $body = $raw | ConvertFrom-Json }
        }
        $post = $req.HttpMethod -eq 'POST'
        $result = switch ($path) {
            '/api/ping' { @{ ok = $true; name = 'max' } }
            '/api/config' { if ($post) { Save-MaxConfig $body; $shared.Models.Clear() }; Get-MaxPublicConfig }
            '/api/stats' { Get-MaxStats }
            '/api/context' { Get-MaxContext }
            '/api/memory' { if ($post) { Update-MaxMemory $body } else { Get-MaxMemory } }
            '/api/history' { if ($post) { Save-MaxHistory $body } else { Get-MaxHistory } }
            '/api/llm' { Invoke-MaxLlm $body $shared }
            '/api/tts/prepare' { New-MaxSpeechJob $body $shared }
            '/api/tts/prewarm' { [MaxTts]::Prewarm(); @{ ok = $true } }
            '/api/tool' { Invoke-MaxTool ([string]$body.name) $body.args }
            '/api/quit' { $shared.Quit = $true; @{ ok = $true } }
            default { $res.StatusCode = 404; @{ ok = $false; error = "Unknown endpoint $path" } }
        }
        Send-MaxJson $res $result
    } catch {
        Write-MaxLog "ERROR $($req.Url.AbsolutePath): $($_.Exception.Message) @ $($_.InvocationInfo.ScriptLineNumber)"
        try { $res.StatusCode = 500; Send-MaxJson $res @{ ok = $false; error = $_.Exception.Message } } catch { }
    } finally {
        try { $res.Close() } catch { }
    }
}

# ------------------------------------------------------------------ browser window

function Find-MaxBrowser([string]$pref) {
    $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
    $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
    $order = if ($pref -eq 'edge') { $edge + $chrome } else { $chrome + $edge }
    foreach ($p in $order) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}

function Open-MaxWindow([string]$url, $cfg) {
    $exe = Find-MaxBrowser $cfg.browser
    if (-not $exe) { Start-Process $url; return $null }
    $profileDir = Join-Path $MaxDataDir 'browser-profile'
    $argList = @(
        "--app=$url", "--user-data-dir=`"$profileDir`"", '--window-size=1280,820',
        '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows', '--disable-features=Translate'
    )
    return Start-Process -FilePath $exe -ArgumentList $argList -PassThru
}

# ------------------------------------------------------------------ stats & context

function Get-MaxStats {
    $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
    $os = Get-CimInstance Win32_OperatingSystem
    $ramTotal = [double]$os.TotalVisibleMemorySize
    $ramUsed = if ($ramTotal) { [Math]::Round(100 * (1 - $os.FreePhysicalMemory / $ramTotal)) } else { 0 }
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
    $bat = Get-CimInstance Win32_Battery | Select-Object -First 1
    $vol = $null; $muted = $null
    try { $vol = [MaxAudio]::GetVolume(); $muted = [MaxAudio]::GetMute() } catch { }
    return [ordered]@{
        ok           = $true
        cpu          = [int]$cpu
        ram          = [int]$ramUsed
        ram_total_gb = [Math]::Round($ramTotal / 1MB, 1)
        disk_free_gb = if ($disk) { [Math]::Round($disk.FreeSpace / 1GB, 1) } else { $null }
        disk_used    = if ($disk -and $disk.Size) { [int](100 * (1 - $disk.FreeSpace / $disk.Size)) } else { $null }
        battery      = if ($bat) { [int]$bat.EstimatedChargeRemaining } else { $null }
        charging     = if ($bat) { $bat.BatteryStatus -eq 2 } else { $null }
        uptime_h     = [Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
        volume       = $vol
        muted        = $muted
        processes    = (Get-Process).Count
    }
}

function Get-MaxLocation {
    $cfg = Get-MaxConfig
    $cached = Read-MaxJson 'location.json' $null
    $city = [string]$cfg.city
    if ($cached -and $cached.query -eq $city -and ((Get-Date) - [DateTime]$cached.time).TotalHours -lt 6) { return $cached }
    $loc = $null
    if ($city) {
        $r = Invoke-MaxHttp "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=$([Uri]::EscapeDataString($city))" -TimeoutSec 10
        $g = ($r.Text | ConvertFrom-Json).results | Select-Object -First 1
        if ($g) { $loc = @{ city = $g.name; country = $g.country; lat = $g.latitude; lon = $g.longitude } }
    }
    if (-not $loc) {
        $r = Invoke-MaxHttp 'http://ip-api.com/json/?fields=status,city,country,lat,lon' -TimeoutSec 8
        $j = $r.Text | ConvertFrom-Json
        if ($j.status -eq 'success') { $loc = @{ city = $j.city; country = $j.country; lat = $j.lat; lon = $j.lon } }
    }
    if (-not $loc) { return $null }
    $loc.query = $city
    $loc.time = (Get-Date).ToString('o')
    Write-MaxJson 'location.json' $loc
    return [pscustomobject]$loc
}

function Get-MaxContext {
    $loc = $null
    try { $loc = Get-MaxLocation } catch { }
    $cfg = Get-MaxConfig
    return [ordered]@{
        ok       = $true
        location = if ($loc) { "$($loc.city), $($loc.country)" } else { '' }
        provider = Resolve-MaxProvider $cfg
    }
}

# ------------------------------------------------------------------ memory

function Get-ClaudeMemories {
    $items = New-Object System.Collections.ArrayList
    $claudeDir = Join-Path $env:USERPROFILE '.claude'
    $files = @()
    $globalMd = Join-Path $claudeDir 'CLAUDE.md'
    if (Test-Path $globalMd) { $files += Get-Item $globalMd }
    $projects = Join-Path $claudeDir 'projects'
    if (Test-Path $projects) {
        foreach ($d in Get-ChildItem $projects -Directory -ErrorAction SilentlyContinue) {
            $mem = Join-Path $d.FullName 'memory'
            if (Test-Path $mem) { $files += Get-ChildItem $mem -Filter *.md -File | Where-Object { $_.Name -ne 'MEMORY.md' } }
        }
    }
    foreach ($f in $files) {
        try {
            $raw = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8)
            $name = $f.BaseName; $desc = ''; $type = ''
            $bodyText = $raw
            $m = [regex]::Match($raw, '^\s*---\s*\r?\n(.*?)\r?\n---\s*\r?\n(.*)$', 'Singleline')
            if ($m.Success) {
                $fm = $m.Groups[1].Value
                $bodyText = $m.Groups[2].Value
                $n = [regex]::Match($fm, '(?m)^name:\s*(.+)$'); if ($n.Success) { $name = $n.Groups[1].Value.Trim() }
                $d = [regex]::Match($fm, '(?m)^description:\s*(.+)$'); if ($d.Success) { $desc = $d.Groups[1].Value.Trim() }
                $t = [regex]::Match($fm, '(?m)^\s*type:\s*(.+)$'); if ($t.Success) { $type = $t.Groups[1].Value.Trim() }
            }
            $bodyText = ($bodyText -replace '\[\[([^\]]+)\]\]', '$1' -replace '\s+', ' ').Trim()
            if ($bodyText.Length -gt 600) { $bodyText = $bodyText.Substring(0, 600) + '...' }
            [void]$items.Add([ordered]@{ name = $name; type = $type; description = $desc; text = $bodyText; modified = $f.LastWriteTime.ToString('yyyy-MM-dd') })
        } catch { }
    }
    return , $items.ToArray()
}

# What the user has talked to Claude Code about recently (their own prompts only).
function Get-ClaudeRecentTopics([int]$maxSessions = 8) {
    $projects = Join-Path $env:USERPROFILE '.claude\projects'
    if (-not (Test-Path $projects)) { return , @() }
    $cache = Read-MaxJson 'claude_topics_cache.json' $null
    $files = Get-ChildItem $projects -Recurse -Filter *.jsonl -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -ne 'subagents' } |
        Sort-Object LastWriteTime -Descending | Select-Object -First $maxSessions
    $stamp = ($files | ForEach-Object { "$($_.FullName)|$($_.LastWriteTime.Ticks)" }) -join ';'
    if ($cache -and $cache.stamp -eq $stamp) { return , @($cache.topics) }

    $topics = New-Object System.Collections.ArrayList
    foreach ($f in $files) {
        $prompts = New-Object System.Collections.ArrayList
        $date = $f.LastWriteTime.ToString('yyyy-MM-dd')
        try {
            $sr = New-Object IO.StreamReader($f.FullName, [Text.Encoding]::UTF8)
            while ($null -ne ($line = $sr.ReadLine())) {
                if ($line -notmatch '"type":"user"' -or $line -match '"isMeta":true' -or $line -match '"tool_result"') { continue }
                # Regex instead of ConvertFrom-Json: lines with pasted images are megabytes long.
                $m = [regex]::Match($line, '"message":\{"role":"user","content":"((?:[^"\\]|\\.)*)"')
                $raw = if ($m.Success) { @($m.Groups[1].Value) } else {
                    @([regex]::Matches($line, '\{"type":"text","text":"((?:[^"\\]|\\.)*)"') | ForEach-Object { $_.Groups[1].Value })
                }
                foreach ($t in $raw) {
                    try { $t = [regex]::Unescape($t) } catch { }
                    $t = $t.Trim()
                    if (-not $t -or $t.StartsWith('<') -or $t.StartsWith('[')) { continue }
                    $t = $t -replace '\s+', ' '
                    if ($t.Length -gt 220) { $t = $t.Substring(0, 220) + '...' }
                    if (-not $prompts.Contains($t)) { [void]$prompts.Add($t) }
                }
                if ($prompts.Count -ge 4) { break }
            }
            $sr.Close()
        } catch { }
        if ($prompts.Count) { [void]$topics.Add([ordered]@{ date = $date; prompts = $prompts.ToArray() }) }
    }
    $arr = $topics.ToArray()
    try { Write-MaxJson 'claude_topics_cache.json' @{ stamp = $stamp; topics = $arr } } catch { }
    return , $arr
}

function Get-MaxFacts {
    # flatten defensively: older versions could save the list wrapped in an extra array
    $out = New-Object System.Collections.ArrayList
    foreach ($x in @(Read-MaxJson 'max_memory.json' @())) {
        foreach ($y in @($x)) { if ($y -and $y.fact) { [void]$out.Add($y) } }
    }
    return , $out.ToArray()
}

function Get-MaxMemory {
    $cfg = Get-MaxConfig
    $about = ''
    $aboutFile = Join-Path $MaxDataDir 'about_me.md'
    if (Test-Path $aboutFile) { $about = [IO.File]::ReadAllText($aboutFile, [Text.Encoding]::UTF8) }
    $claude = @(); $topics = @(); $chats = ''
    if ($cfg.use_claude_memory) {
        try { $claude = Get-ClaudeMemories } catch { }
        try { $topics = Get-ClaudeRecentTopics } catch { }
        # summary of the user's claude.ai chats (data\claude_chats.md)
        $chatsFile = Join-Path $MaxDataDir 'claude_chats.md'
        if (Test-Path $chatsFile) { $chats = [IO.File]::ReadAllText($chatsFile, [Text.Encoding]::UTF8) }
    }
    return [ordered]@{
        ok     = $true
        about  = $about
        facts  = Get-MaxFacts
        claude = $claude
        claude_topics = $topics
        claude_chats  = $chats
    }
}

function Update-MaxMemory($body) {
    $facts = New-Object System.Collections.ArrayList
    foreach ($f in (Get-MaxFacts)) { [void]$facts.Add($f) }
    $changed = 0
    switch ([string]$body.action) {
        'add' {
            foreach ($fact in @($body.facts)) {
                $fact = ([string]$fact).Trim()
                if ($fact.Length -lt 4) { continue }
                $dup = $facts | Where-Object { $_.fact -eq $fact -or $_.fact.ToLower().Contains($fact.ToLower()) }
                if ($dup) { continue }
                [void]$facts.Add([ordered]@{ id = [guid]::NewGuid().ToString('N').Substring(0, 8); fact = $fact; added = (Get-Date).ToString('yyyy-MM-dd') })
                $changed++
            }
            while ($facts.Count -gt 300) { $facts.RemoveAt(0) }
        }
        'delete' {
            $keep = @($facts | Where-Object { $_.id -ne $body.id })
            $changed = $facts.Count - $keep.Count
            $facts = [System.Collections.ArrayList]$keep
        }
        'forget' {
            $q = ([string]$body.text).ToLower()
            $words = @($q -split '\W+' | Where-Object { $_.Length -gt 3 })
            $keep = @($facts | Where-Object {
                    $f = $_.fact.ToLower()
                    -not ($f.Contains($q) -or ($words.Count -and @($words | Where-Object { $f.Contains($_) }).Count -ge [Math]::Max(1, [Math]::Ceiling($words.Count * 0.6))))
                })
            $changed = $facts.Count - $keep.Count
            $facts = [System.Collections.ArrayList]$keep
        }
        'about' {
            [IO.File]::WriteAllText((Join-Path $MaxDataDir 'about_me.md'), [string]$body.text, (New-Object Text.UTF8Encoding $false))
            $changed = 1
        }
    }
    Write-MaxJson 'max_memory.json' @($facts.ToArray())
    return @{ ok = $true; changed = $changed; count = $facts.Count }
}

function Get-MaxHistory {
    return @{ ok = $true; messages = @(Read-MaxJson 'history.json' @()) }
}

function Save-MaxHistory($body) {
    $msgs = @($body.messages)
    if ($msgs.Count -gt 60) { $msgs = $msgs[($msgs.Count - 60)..($msgs.Count - 1)] }
    Write-MaxJson 'history.json' $msgs
    return @{ ok = $true }
}

# ------------------------------------------------------------------ AI providers (all have free tiers)

function Resolve-MaxProvider($cfg) {
    $p = [string]$cfg.provider
    if ($p -and $p -ne 'auto') { return $p }
    if ($cfg.groq_key) { return 'groq' }
    if ($cfg.gemini_key) { return 'gemini' }
    if ($cfg.openrouter_key) { return 'openrouter' }
    # Probing for a local Ollama costs up to a second, so remember the answer for a minute.
    $probe = $global:MaxOllamaProbe
    if (-not $probe -or ((Get-Date) - $probe.Time).TotalSeconds -gt 60 -or $probe.Url -ne $cfg.ollama_url) {
        $ok = $false
        try {
            $r = Invoke-MaxHttp "$($cfg.ollama_url)/api/tags" -TimeoutSec 1
            $ok = $r.Status -eq 200 -and @(($r.Text | ConvertFrom-Json).models).Count -gt 0
        } catch { }
        $probe = @{ Time = Get-Date; Url = $cfg.ollama_url; Ok = $ok }
        $global:MaxOllamaProbe = $probe
    }
    if ($probe.Ok) { return 'ollama' }
    return 'offline'
}

function Select-MaxModel([string[]]$available, [string[]]$preferred, [scriptblock]$fallbackFilter, [string[]]$exclude) {
    foreach ($p in $preferred) { if ($available -contains $p -and $exclude -notcontains $p) { return $p } }
    $rest = @($available | Where-Object { $exclude -notcontains $_ } | Where-Object $fallbackFilter | Sort-Object -Descending)
    if ($rest.Count) { return $rest[0] }
    return $null
}

function Get-MaxModel([string]$provider, $cfg, $shared, [string[]]$exclude = @()) {
    if ($cfg.model) { return [string]$cfg.model }
    $key = "$provider|$($exclude -join ',')"
    if ($shared.Models.ContainsKey($key)) { return $shared.Models[$key] }
    $model = $null
    $ids = @()
    switch ($provider) {
        'groq' {
            $r = Invoke-MaxHttp 'https://api.groq.com/openai/v1/models' -Headers @{ Authorization = "Bearer $($cfg.groq_key)" } -TimeoutSec 15
            $ids = @(($r.Text | ConvertFrom-Json).data | ForEach-Object { $_.id })
            $model = Select-MaxModel $ids @('openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct-0905', 'moonshotai/kimi-k2-instruct',
                'meta-llama/llama-4-maverick-17b-128e-instruct', 'qwen/qwen3.8-27b', 'qwen/qwen3-32b',
                'meta-llama/llama-4-scout-17b-16e-instruct', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant') `
            { $_ -match 'llama|gpt-oss|kimi|qwen' -and $_ -notmatch 'guard|whisper|tts|vision|embed' } $exclude
            if (-not $model) { $model = 'llama-3.3-70b-versatile' }
        }
        'gemini' {
            $r = Invoke-MaxHttp "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=$($cfg.gemini_key)" -TimeoutSec 15
            $ids = @(($r.Text | ConvertFrom-Json).models | Where-Object { $_.supportedGenerationMethods -contains 'generateContent' } |
                    ForEach-Object { $_.name -replace '^models/', '' })
            $model = Select-MaxModel $ids @('gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.0-flash-lite') `
            { $_ -match 'flash' -and $_ -notmatch 'image|tts|live|audio|embedding|thinking|exp' } $exclude
            if (-not $model) { $model = 'gemini-2.5-flash' }
        }
        'openrouter' {
            $r = Invoke-MaxHttp 'https://openrouter.ai/api/v1/models' -TimeoutSec 20
            $ids = @([regex]::Matches($r.Text, '"id"\s*:\s*"([^"]+:free)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
            $model = Select-MaxModel $ids @('meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat-v3-0324:free', 'google/gemini-2.0-flash-exp:free',
                'mistralai/mistral-small-3.2-24b-instruct:free', 'qwen/qwen3-235b-a22b:free') { $_ -match 'llama|deepseek|gemini|mistral|qwen' } $exclude
            if (-not $model) { $model = 'meta-llama/llama-3.3-70b-instruct:free' }
        }
        'ollama' {
            $r = Invoke-MaxHttp "$($cfg.ollama_url)/api/tags" -TimeoutSec 3
            $ids = @(($r.Text | ConvertFrom-Json).models | ForEach-Object { $_.name } | Where-Object { $exclude -notcontains $_ })
            $model = $ids[0]
        }
    }
    # Only remember a choice that came from a real model list (not a guess after a bad key).
    if ($model -and $ids.Count) { $shared.Models[$key] = $model }
    return $model
}

function Invoke-MaxChatOpenAI([string]$url, [hashtable]$headers, [string]$model, $messages, [bool]$json) {
    $payload = [ordered]@{ model = $model; messages = $messages; temperature = 0.85; max_tokens = 700 }
    if ($json) { $payload.response_format = @{ type = 'json_object' } }
    # gpt-oss "thinks" before answering; low effort halves the wait and is plenty for an assistant.
    if ($url -match 'groq\.com' -and $model -match 'gpt-oss') { $payload.reasoning_effort = 'low' }
    $r = Invoke-MaxHttp $url -Method POST -Headers $headers -Body $payload -TimeoutSec 45
    if ($r.Status -eq 400 -and $payload.Contains('reasoning_effort') -and $r.Text -match 'reasoning') {
        $payload.Remove('reasoning_effort')
        $r = Invoke-MaxHttp $url -Method POST -Headers $headers -Body $payload -TimeoutSec 45
    }
    if ($r.Status -eq 400 -and $json -and $r.Text -match 'response_format|json') {
        $payload.Remove('response_format')
        $r = Invoke-MaxHttp $url -Method POST -Headers $headers -Body $payload -TimeoutSec 45
    }
    if ($r.Status -ne 200) { return @{ ok = $false; status = $r.Status; error = (Get-MaxErrorMessage $r) } }
    $j = $r.Text | ConvertFrom-Json
    return @{ ok = $true; text = [string]$j.choices[0].message.content; tokens = $j.usage.total_tokens }
}

function Invoke-MaxChatGemini([string]$key, [string]$model, $messages, [bool]$json) {
    $system = (@($messages | Where-Object { $_.role -eq 'system' } | ForEach-Object { $_.content }) -join "`n`n")
    $contents = New-Object System.Collections.ArrayList
    foreach ($m in @($messages | Where-Object { $_.role -ne 'system' })) {
        $role = if ($m.role -eq 'assistant') { 'model' } else { 'user' }
        if ($contents.Count -eq 0 -and $role -eq 'model') { [void]$contents.Add(@{ role = 'user'; parts = @(@{ text = '(conversation resumed)' }) }) }
        if ($contents.Count -and $contents[$contents.Count - 1].role -eq $role) {
            $contents[$contents.Count - 1].parts[0].text += "`n`n" + [string]$m.content
        } else {
            [void]$contents.Add(@{ role = $role; parts = @(@{ text = [string]$m.content }) })
        }
    }
    $gen = [ordered]@{ temperature = 0.85; maxOutputTokens = 1024 }
    if ($json) { $gen.responseMimeType = 'application/json' }
    if ($model -match '2\.5-flash') { $gen.thinkingConfig = @{ thinkingBudget = 0 } }
    $payload = [ordered]@{ contents = $contents.ToArray(); generationConfig = $gen }
    if ($system) { $payload.systemInstruction = @{ parts = @(@{ text = $system }) } }
    $url = "https://generativelanguage.googleapis.com/v1beta/models/$($model):generateContent"
    $r = Invoke-MaxHttp $url -Method POST -Headers @{ 'x-goog-api-key' = $key } -Body $payload -TimeoutSec 45
    if ($r.Status -ne 200) { return @{ ok = $false; status = $r.Status; error = (Get-MaxErrorMessage $r) } }
    $j = $r.Text | ConvertFrom-Json
    $text = (@($j.candidates[0].content.parts | Where-Object { -not $_.thought } | ForEach-Object { $_.text }) -join '')
    if (-not $text) { return @{ ok = $false; status = 200; error = "Empty reply ($($j.candidates[0].finishReason))" } }
    return @{ ok = $true; text = $text }
}

function Invoke-MaxChatOllama([string]$base, [string]$model, $messages, [bool]$json) {
    $payload = [ordered]@{ model = $model; messages = $messages; stream = $false; options = @{ temperature = 0.85 } }
    if ($json) { $payload.format = 'json' }
    $r = Invoke-MaxHttp "$base/api/chat" -Method POST -Body $payload -TimeoutSec 120
    if ($r.Status -ne 200) { return @{ ok = $false; status = $r.Status; error = (Get-MaxErrorMessage $r) } }
    return @{ ok = $true; text = [string]($r.Text | ConvertFrom-Json).message.content }
}

function Invoke-MaxLlm($body, $shared) {
    $cfg = Get-MaxConfig
    $provider = Resolve-MaxProvider $cfg
    if ($provider -eq 'offline') { return @{ ok = $false; offline = $true; error = 'No AI provider is configured.' } }
    $messages = @($body.messages | ForEach-Object { [ordered]@{ role = [string]$_.role; content = [string]$_.content } })
    $json = [bool]$body.json
    $tried = @()
    $waited = $false
    $r = @{ ok = $false; status = 0; error = "No usable model found for $provider." }
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $model = Get-MaxModel $provider $cfg $shared $tried
        if (-not $model) { break }
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = switch ($provider) {
            'groq' { Invoke-MaxChatOpenAI 'https://api.groq.com/openai/v1/chat/completions' @{ Authorization = "Bearer $($cfg.groq_key)" } $model $messages $json }
            'openrouter' { Invoke-MaxChatOpenAI 'https://openrouter.ai/api/v1/chat/completions' @{ Authorization = "Bearer $($cfg.openrouter_key)"; 'X-Title' = 'Max Assistant' } $model $messages $json }
            'gemini' { Invoke-MaxChatGemini $cfg.gemini_key $model $messages $json }
            'ollama' { Invoke-MaxChatOllama $cfg.ollama_url $model $messages $json }
            default { @{ ok = $false; status = 0; error = "Unknown provider '$provider'" } }
        }
        Write-MaxLog "LLM $provider/$model $($sw.ElapsedMilliseconds) ms$(if ($r.tokens) { ", $($r.tokens) tokens" })$(if (-not $r.ok) { ' (failed)' })"
        if ($r.ok) { return @{ ok = $true; text = $r.text; provider = $provider; model = $model } }
        Write-MaxLog "LLM $provider/$model failed ($($r.status)): $($r.error)"
        # Per-minute token limit with a short wait: wait it out and keep the better model.
        if ($r.status -eq 429 -and -not $waited -and [string]$r.error -match 'try again in ([\d.]+)(ms|s)\b') {
            $ms = [double]$Matches[1] * $(if ($Matches[2] -eq 's') { 1000 } else { 1 })
            if ($ms -le 2500) { $waited = $true; Start-Sleep -Milliseconds ([int]$ms + 150); $attempt--; continue }
        }
        # Rate limited, or the model was retired: try the next best model once or twice.
        if ($cfg.model -or $r.status -notin @(404, 410, 429, 503, 400)) { break }
        if ($r.status -eq 400 -and $r.error -notmatch 'model|decommission|not found|not supported') { break }
        $tried += $model
    }
    return @{ ok = $false; provider = $provider; status = $r.status; error = $r.error }
}

# ------------------------------------------------------------------ voice

# The page first registers what to say (POST /api/tts/prepare), then plays /api/tts/stream?id=...
# in an <audio> element, so playback starts with the first audio bytes instead of after the whole sentence.
$MaxVoice = 'Microsoft Server Speech Text to Speech Voice (en-US, BrianMultilingualNeural)'   # Max has one voice: Brian

function New-MaxSpeechJob($body, $shared) {
    $text = ([string]$body.text).Trim()
    if (-not $text) { return @{ ok = $false; error = 'empty text' } }
    if ($text.Length -gt 2500) { $text = $text.Substring(0, 2500) }
    $voice = $MaxVoice
    foreach ($k in @($shared.Tts.Keys)) { if (((Get-Date) - $shared.Tts[$k].Time).TotalMinutes -gt 3) { $shared.Tts.Remove($k) } }
    $id = [guid]::NewGuid().ToString('N')
    $shared.Tts[$id] = @{
        Time  = Get-Date
        Text  = $text
        Voice = $voice
        # always neutral: any rate/pitch change makes the service 1-3 s slower to start speaking
        Rate  = '+0%'
        Pitch = '+0Hz'
    }
    return @{ ok = $true; id = $id }
}

function Send-MaxSpeechStream($req, $res, $shared) {
    $job = $shared.Tts[[string]$req.QueryString['id']]
    if (-not $job) { $res.StatusCode = 404; return }
    $res.ContentType = 'audio/mpeg'
    $res.SendChunked = $true
    $res.Headers['Cache-Control'] = 'no-store'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    [MaxTts]::LastError = ''
    try {
        $queued = [int]((Get-Date) - $job.Time).TotalMilliseconds
        [void][MaxTts]::SpeakTo($res.OutputStream, $job.Text, $job.Voice, $job.Rate, $job.Pitch, '+0%')
        Write-MaxLog "TTS $($sw.ElapsedMilliseconds) ms (since prepare $queued ms; $([MaxTts]::LastTake); $([MaxTts]::LastTiming)) $([MaxTts]::LastError)"
    } catch {
        $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }
        Write-MaxLog "TTS failed after $($sw.ElapsedMilliseconds) ms: $($e.Message)"
        try { $res.StatusCode = 503 } catch { }   # only possible if no audio went out yet
    }
}

# ------------------------------------------------------------------ Windows tools

function Get-MaxApps {
    if ($global:MaxAppsCache -and ((Get-Date) - $global:MaxAppsCacheTime).TotalMinutes -lt 10) { return $global:MaxAppsCache }
    $apps = @()
    try { $apps = @(Get-StartApps | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Id = $_.AppID } }) } catch { }
    if (-not $apps.Count) {
        $dirs = @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")
        $apps = @(Get-ChildItem $dirs -Recurse -Include *.lnk, *.url -ErrorAction SilentlyContinue |
                ForEach-Object { [pscustomobject]@{ Name = $_.BaseName; Id = $_.FullName } })
    }
    $global:MaxAppsCache = $apps
    $global:MaxAppsCacheTime = Get-Date
    return $apps
}

function ConvertTo-MaxKey([string]$s) { return (($s.ToLower() -replace '[^a-z0-9]+', ' ').Trim()) }

$MaxBuiltinApps = [ordered]@{
    'notepad' = 'notepad.exe'; 'calculator' = 'calc.exe'; 'calc' = 'calc.exe'; 'paint' = 'mspaint.exe'
    'command prompt' = 'cmd.exe'; 'cmd' = 'cmd.exe'; 'powershell' = 'powershell.exe'; 'terminal' = 'wt.exe'
    'task manager' = 'taskmgr.exe'; 'file explorer' = 'explorer.exe'; 'explorer' = 'explorer.exe'; 'files' = 'explorer.exe'
    'this pc' = 'explorer.exe'; 'my computer' = 'explorer.exe'; 'control panel' = 'control.exe'
    'settings' = 'ms-settings:'; 'windows settings' = 'ms-settings:'; 'bluetooth' = 'ms-settings:bluetooth'
    'wifi' = 'ms-settings:network-wifi'; 'wi fi' = 'ms-settings:network-wifi'; 'display settings' = 'ms-settings:display'
    'sound settings' = 'ms-settings:sound'; 'windows update' = 'ms-settings:windowsupdate'
    'camera' = 'microsoft.windows.camera:'; 'microsoft store' = 'ms-windows-store:'; 'store' = 'ms-windows-store:'
    'clock' = 'ms-clock:'; 'alarms' = 'ms-clock:'; 'snipping tool' = 'ms-screenclip:'; 'photos' = 'ms-photos:'
    'device manager' = 'devmgmt.msc'; 'browser' = 'https://www.google.com'; 'google' = 'https://www.google.com'
    'youtube' = 'https://www.youtube.com'; 'gmail' = 'https://mail.google.com'; 'github' = 'https://github.com'; 'instagram' = 'https://www.instagram.com'
}
# Used only when no installed app with that name exists.
$MaxWebFallback = @{ 'claude' = 'https://claude.ai'; 'chatgpt' = 'https://chatgpt.com'; 'telegram' = 'https://web.telegram.org'; 'whatsapp' = 'https://web.whatsapp.com' }
# Speech recognition hears "Claude" as "cloud"/"clod"; Adobe Creative Cloud is still reachable by its full name.
$MaxAppAliases = @{ 'vs code' = 'visual studio code'; 'vscode' = 'visual studio code'; 'code' = 'visual studio code'; 'chrome' = 'google chrome'; 'edge' = 'microsoft edge'
    'cloud' = 'claude'; 'cloud app' = 'claude'; 'clod' = 'claude'; 'claude app' = 'claude'; 'cloud ai' = 'claude' }

function Find-MaxApp([string]$query) {
    $q = ConvertTo-MaxKey $query
    if ($MaxAppAliases.ContainsKey($q)) { $q = $MaxAppAliases[$q] }
    $qWords = @($q -split ' ' | Where-Object { $_ })
    $best = $null; $bestScore = 0
    foreach ($a in Get-MaxApps) {
        $n = ConvertTo-MaxKey $a.Name
        if ($n -match 'uninstall|readme|release notes|documentation|help|website|manual') { continue }
        $score = 0
        if ($n -eq $q) { $score = 100 }
        elseif ($n.StartsWith("$q ")) { $score = 85 }
        elseif (" $n " -like "* $q *") { $score = 75 }
        elseif ($n.Contains($q)) { $score = 60 }
        else {
            $hit = @($qWords | Where-Object { " $n " -like "* $_ *" }).Count
            if ($qWords.Count -and $hit -eq $qWords.Count) { $score = 50 }
        }
        if ($score -gt 0) { $score -= [Math]::Min(15, $n.Length / 6) }
        if ($score -gt $bestScore) { $best = $a; $bestScore = $score }
    }
    return $best
}

function Open-MaxApp([string]$name) {
    $key = ConvertTo-MaxKey $name
    if (-not $key) { return @{ ok = $false; result = 'No app name given.' } }
    if ($MaxBuiltinApps.Contains($key)) {
        $t = $MaxBuiltinApps[$key]
        if ($t -eq 'wt.exe' -and -not (Get-Command wt.exe -ErrorAction SilentlyContinue)) { $t = 'powershell.exe' }
        Start-Process $t
        return @{ ok = $true; result = "Opened $name." }
    }
    $app = Find-MaxApp $name
    if ($app) {
        if ($app.Id -match '^[a-zA-Z]:\\' -and (Test-Path $app.Id)) { Start-Process $app.Id }
        else { Start-Process explorer.exe "shell:AppsFolder\$($app.Id)" }
        return @{ ok = $true; result = "Opened $($app.Name)." }
    }
    $cmd = Get-Command "$key.exe" -ErrorAction SilentlyContinue
    if ($cmd) { Start-Process $cmd.Source; return @{ ok = $true; result = "Opened $name." } }
    $web = if ($MaxAppAliases.ContainsKey($key)) { $MaxWebFallback[$MaxAppAliases[$key]] } else { $MaxWebFallback[$key] }
    if ($web) { Start-Process $web; return @{ ok = $true; result = "No $name app installed, so I opened $web in the browser." } }
    return @{ ok = $false; result = "I couldn't find an app called '$name' on this PC." }
}

$MaxProtectedProcs = @('explorer', 'dwm', 'csrss', 'winlogon', 'lsass', 'services', 'svchost', 'system', 'smss', 'wininit',
    'applicationframehost', 'shellexperiencehost', 'startmenuexperiencehost', 'searchui', 'searchapp', 'textinputhost',
    'sihost', 'ctfmon', 'fontdrvhost', 'powershell', 'pwsh', 'conhost', 'runtimebroker', 'lockapp', 'securityhealthsystray')
$MaxProcAliases = @{ 'google chrome' = 'chrome'; 'edge' = 'msedge'; 'microsoft edge' = 'msedge'; 'word' = 'winword'; 'powerpoint' = 'powerpnt';
    'vs code' = 'code'; 'vscode' = 'code'; 'visual studio code' = 'code'; 'file explorer' = 'explorer'; 'paint' = 'mspaint' }

function Close-MaxApp([string]$name) {
    $q = ConvertTo-MaxKey $name
    if ($MaxAppAliases.ContainsKey($q) -and $MaxAppAliases[$q] -eq 'claude') { $q = 'claude' }
    if ($MaxProcAliases.ContainsKey($q)) { $q = $MaxProcAliases[$q] }
    if (-not $q) { return @{ ok = $false; result = 'No app name given.' } }
    # Never close the window Max itself lives in.
    $profileMark = (Join-Path $MaxDataDir 'browser-profile').ToLower()
    $mine = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($profileMark) } | ForEach-Object { [int]$_.ProcessId })
    $procs = @(Get-Process | Where-Object {
            $_.MainWindowHandle -ne 0 -and $_.Id -ne $PID -and $mine -notcontains $_.Id -and
            $MaxProtectedProcs -notcontains $_.ProcessName.ToLower() -and
            ((ConvertTo-MaxKey $_.ProcessName).Replace(' ', '') -like "*$($q.Replace(' ', ''))*" -or (ConvertTo-MaxKey $_.MainWindowTitle) -like "*$q*")
        })
    if (-not $procs.Count) { return @{ ok = $false; result = "No open window matching '$name'." } }
    foreach ($p in $procs) { [void]$p.CloseMainWindow() }
    $names = ($procs | ForEach-Object { $_.ProcessName } | Select-Object -Unique) -join ', '
    return @{ ok = $true; result = "Asked $names to close (unsaved work will prompt)." }
}

function Get-MaxFolder([string]$name) {
    $k = ConvertTo-MaxKey $name
    switch -Regex ($k) {
        '^download' { return 'shell:Downloads' }
        '^document|^my document' { return 'shell:Personal' }
        '^desktop' { return 'shell:Desktop' }
        '^picture|^photo|^image' { return 'shell:My Pictures' }
        '^music|^song' { return 'shell:My Music' }
        '^video|^movie' { return 'shell:My Video' }
        '^home|^user|^profile' { return $env:USERPROFILE }
        '^recycle|^trash|^bin' { return 'shell:RecycleBinFolder' }
        '^screenshot' { $d = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'Max Screenshots'; New-Item -ItemType Directory -Force $d | Out-Null; return $d }
        '^max' { return $MaxRoot }
        '^this pc|^computer|^drives' { return 'shell:MyComputerFolder' }
    }
    if ($name -match '^[a-zA-Z]:\\' -and (Test-Path $name -PathType Container)) { return $name }
    return $null
}

$MaxBlockedExt = @('.exe', '.bat', '.cmd', '.com', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.reg', '.hta', '.cpl', '.jar', '.lnk', '.pif')

function Find-MaxFiles([string]$query) {
    $words = @((ConvertTo-MaxKey $query) -split ' ' | Where-Object { $_.Length -gt 1 })
    if (-not $words.Count) { return @() }
    $found = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    foreach ($r in 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos') {
        $d = Join-Path $env:USERPROFILE $r
        if (Test-Path $d) { $stack.Push(@($d, 0)) }
    }
    $deadline = (Get-Date).AddSeconds(5)
    while ($stack.Count -and $found.Count -lt 40 -and (Get-Date) -lt $deadline) {
        $item = $stack.Pop()
        try {
            foreach ($f in [IO.Directory]::EnumerateFiles($item[0])) {
                $n = ConvertTo-MaxKey ([IO.Path]::GetFileNameWithoutExtension($f))
                if (@($words | Where-Object { $n.Contains($_) }).Count -eq $words.Count) { [void]$found.Add((Get-Item -LiteralPath $f)) }
            }
            if ($item[1] -lt 4) {
                foreach ($sub in [IO.Directory]::EnumerateDirectories($item[0])) {
                    if ([IO.Path]::GetFileName($sub) -notmatch '^\.|^node_modules$|^__pycache__$') { $stack.Push(@($sub, $item[1] + 1)) }
                }
            }
        } catch { }
    }
    return @($found | Sort-Object LastWriteTime -Descending | Select-Object -First 6)
}

function Get-MaxWeatherText([int]$code) {
    switch ($code) {
        0 { 'clear sky' } 1 { 'mainly clear' } 2 { 'partly cloudy' } 3 { 'overcast' } 45 { 'fog' } 48 { 'freezing fog' }
        51 { 'light drizzle' } 53 { 'drizzle' } 55 { 'heavy drizzle' } 56 { 'freezing drizzle' } 57 { 'freezing drizzle' }
        61 { 'light rain' } 63 { 'rain' } 65 { 'heavy rain' } 66 { 'freezing rain' } 67 { 'freezing rain' }
        71 { 'light snow' } 73 { 'snow' } 75 { 'heavy snow' } 77 { 'snow grains' } 80 { 'light showers' } 81 { 'showers' }
        82 { 'violent showers' } 85 { 'snow showers' } 86 { 'heavy snow showers' } 95 { 'thunderstorm' } 96 { 'thunderstorm with hail' }
        99 { 'thunderstorm with heavy hail' } default { 'unknown conditions' }
    }
}

function Get-MaxWeather([string]$city) {
    $loc = $null
    if ($city) {
        $r = Invoke-MaxHttp "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=$([Uri]::EscapeDataString($city))" -TimeoutSec 10
        $g = ($r.Text | ConvertFrom-Json).results | Select-Object -First 1
        if (-not $g) { return @{ ok = $false; info = $true; result = "I couldn't find a place called '$city'." } }
        $loc = [pscustomobject]@{ city = $g.name; country = $g.country; lat = $g.latitude; lon = $g.longitude }
    } else { $loc = Get-MaxLocation }
    if (-not $loc) { return @{ ok = $false; info = $true; result = 'Location unknown. Set your city in settings.' } }
    $u = "https://api.open-meteo.com/v1/forecast?latitude=$($loc.lat)&longitude=$($loc.lon)&timezone=auto&forecast_days=2" +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code'
    $w = (Invoke-MaxHttp $u -TimeoutSec 12).Text | ConvertFrom-Json
    $c = $w.current; $d = $w.daily
    $txt = "$($loc.city), $($loc.country): now $([Math]::Round($c.temperature_2m)) C (feels like $([Math]::Round($c.apparent_temperature)) C), " +
    "$(Get-MaxWeatherText $c.weather_code), humidity $($c.relative_humidity_2m)%, wind $([Math]::Round($c.wind_speed_10m)) km/h. " +
    "Today: high $([Math]::Round($d.temperature_2m_max[0])) C, low $([Math]::Round($d.temperature_2m_min[0])) C, $($d.precipitation_probability_max[0])% chance of rain. " +
    "Tomorrow: $(Get-MaxWeatherText $d.weather_code[1]), $([Math]::Round($d.temperature_2m_min[1]))-$([Math]::Round($d.temperature_2m_max[1])) C, $($d.precipitation_probability_max[1])% chance of rain."
    return @{ ok = $true; info = $true; result = $txt }
}

$MaxNewsFeeds = @{
    top = 'https://feeds.bbci.co.uk/news/rss.xml'; world = 'https://feeds.bbci.co.uk/news/world/rss.xml'
    technology = 'https://feeds.bbci.co.uk/news/technology/rss.xml'; tech = 'https://feeds.bbci.co.uk/news/technology/rss.xml'
    business = 'https://feeds.bbci.co.uk/news/business/rss.xml'; science = 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml'
    health = 'https://feeds.bbci.co.uk/news/health/rss.xml'; sports = 'https://feeds.bbci.co.uk/sport/rss.xml'; sport = 'https://feeds.bbci.co.uk/sport/rss.xml'
    entertainment = 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml'
}

function Get-MaxNews([string]$topic) {
    $t = ConvertTo-MaxKey $topic
    $url = if ($MaxNewsFeeds.ContainsKey($t)) { $MaxNewsFeeds[$t] } else { $MaxNewsFeeds.top }
    [xml]$x = (Invoke-MaxHttp $url -TimeoutSec 12).Text
    $items = @($x.SelectNodes('//item') | Select-Object -First 6 | ForEach-Object {
            "- $($_.SelectSingleNode('title').InnerText.Trim()): $($_.SelectSingleNode('description').InnerText.Trim())" })
    return @{ ok = $true; info = $true; result = "BBC headlines ($(if ($t) { $t } else { 'top' })):`n" + ($items -join "`n") }
}

function Get-MaxWikipedia([string]$query) {
    $s = (Invoke-MaxHttp "https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&srsearch=$([Uri]::EscapeDataString($query))" -TimeoutSec 10).Text | ConvertFrom-Json
    $title = $s.query.search[0].title
    if (-not $title) { return @{ ok = $false; info = $true; result = "Wikipedia has nothing on '$query'." } }
    $sum = (Invoke-MaxHttp "https://en.wikipedia.org/api/rest_v1/page/summary/$([Uri]::EscapeDataString($title.Replace(' ', '_')))" -TimeoutSec 10).Text | ConvertFrom-Json
    $ex = [string]$sum.extract
    if ($ex.Length -gt 900) { $ex = $ex.Substring(0, 900) + '...' }
    return @{ ok = $true; info = $true; result = "Wikipedia - $($title): $ex" }
}

function Invoke-MaxYouTube([string]$query) {
    $search = "https://www.youtube.com/results?search_query=$([Uri]::EscapeDataString($query))"
    try {
        $r = Invoke-MaxHttp $search -Headers @{ 'Accept-Language' = 'en-US,en;q=0.9'; 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36' } -TimeoutSec 12
        $m = [regex]::Match($r.Text, '"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"')
        if ($m.Success) {
            Start-Process "https://www.youtube.com/watch?v=$($m.Groups[1].Value)"
            $title = [regex]::Unescape($m.Groups[2].Value)
            return @{ ok = $true; result = "Playing '$title' on YouTube." }
        }
    } catch { }
    Start-Process $search
    return @{ ok = $true; result = "Opened YouTube results for '$query'." }
}

function Invoke-MaxTool([string]$name, $a) {
    if (-not $a) { $a = [pscustomobject]@{} }
    try {
        switch ($name) {
            'open_app' { return Open-MaxApp ([string]$a.name) }
            'close_app' { return Close-MaxApp ([string]$a.name) }
            'open_website' {
                $u = ([string]$a.url).Trim()
                if ($u -notmatch '^https?://') { $u = "https://$u" }
                if (-not [Uri]::IsWellFormedUriString($u, 'Absolute')) { return @{ ok = $false; result = 'That does not look like a web address.' } }
                Start-Process $u
                return @{ ok = $true; result = "Opened $u" }
            }
            'web_search' {
                $q = [Uri]::EscapeDataString([string]$a.query)
                $u = switch ([string]$a.site) {
                    'youtube' { "https://www.youtube.com/results?search_query=$q" }
                    'images' { "https://www.google.com/search?tbm=isch&q=$q" }
                    'maps' { "https://www.google.com/maps/search/$q" }
                    'wikipedia' { "https://en.wikipedia.org/wiki/Special:Search?search=$q" }
                    default { "https://www.google.com/search?q=$q" }
                }
                Start-Process $u
                return @{ ok = $true; result = "Searched for '$($a.query)'." }
            }
            'play_youtube' { return Invoke-MaxYouTube ([string]$a.query) }
            'open_folder' {
                $f = Get-MaxFolder ([string]$a.name)
                if (-not $f) { return @{ ok = $false; result = "I don't know a folder called '$($a.name)'." } }
                Start-Process explorer.exe "`"$f`""
                return @{ ok = $true; result = "Opened $($a.name)." }
            }
            'find_file' {
                $files = Find-MaxFiles ([string]$a.name)
                if (-not $files.Count) { return @{ ok = $true; info = $true; result = "No files matching '$($a.name)' in your user folders." } }
                $list = ($files | ForEach-Object { "$($_.FullName) (modified $($_.LastWriteTime.ToString('yyyy-MM-dd')))" }) -join "`n"
                return @{ ok = $true; info = $true; result = "Found:`n$list" }
            }
            'open_file' {
                $p = [string]$a.path
                if (-not (Test-Path $p -PathType Leaf)) {
                    $hit = Find-MaxFiles $p | Select-Object -First 1
                    if ($hit) { $p = $hit.FullName } else { return @{ ok = $false; result = "File not found: $($a.path)" } }
                }
                $full = (Resolve-Path $p).Path
                if ($MaxBlockedExt -contains ([IO.Path]::GetExtension($full).ToLower())) { return @{ ok = $false; result = 'For safety I only open documents and media, not programs or scripts.' } }
                Start-Process $full
                return @{ ok = $true; result = "Opened $([IO.Path]::GetFileName($full))." }
            }
            'media' {
                $vk = switch ([string]$a.action) { 'next' { 0xB0 } 'previous' { 0xB1 } 'stop' { 0xB2 } default { 0xB3 } }
                [MaxKeys]::Press([byte]$vk)
                return @{ ok = $true; result = "Media: $($a.action)." }
            }
            'volume' {
                $cur = [MaxAudio]::GetVolume()
                $step = if ($a.level) { [int]$a.level } else { 10 }
                switch ([string]$a.action) {
                    'up' { [MaxAudio]::SetMute($false); [MaxAudio]::SetVolume($cur + $step) }
                    'down' { [MaxAudio]::SetVolume($cur - $step) }
                    'set' { [MaxAudio]::SetMute($false); [MaxAudio]::SetVolume([int]$a.level) }
                    'mute' { [MaxAudio]::SetMute($true) }
                    'unmute' { [MaxAudio]::SetMute($false) }
                }
                return @{ ok = $true; result = "Volume is now $([MaxAudio]::GetVolume())%$(if ([MaxAudio]::GetMute()) { ' (muted)' })." }
            }
            'brightness' {
                try {
                    $cur = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness
                    $lvl = switch ([string]$a.action) { 'up' { $cur + 15 } 'down' { $cur - 15 } default { [int]$a.level } }
                    $lvl = [Math]::Max(0, [Math]::Min(100, $lvl))
                    $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1
                    [void](Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]$lvl })
                    return @{ ok = $true; result = "Brightness set to $lvl%." }
                } catch { return @{ ok = $false; result = "This screen doesn't let me change brightness (usually only laptops do)." } }
            }
            'screenshot' {
                $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
                $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
                $g = [System.Drawing.Graphics]::FromImage($bmp)
                $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
                $dir = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'Max Screenshots'
                New-Item -ItemType Directory -Force $dir | Out-Null
                $file = Join-Path $dir ("Screenshot {0:yyyy-MM-dd HH-mm-ss}.png" -f (Get-Date))
                $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
                $g.Dispose(); $bmp.Dispose()
                return @{ ok = $true; result = "Screenshot saved to Pictures\Max Screenshots." ; path = $file }
            }
            'lock_pc' { Start-Process rundll32.exe 'user32.dll,LockWorkStation'; return @{ ok = $true; result = 'Locked.' } }
            'power' {
                $act = [string]$a.action
                if ($act -ne 'cancel' -and -not $a.confirmed) { return @{ ok = $false; result = 'Needs confirmation from the user first.' } }
                switch ($act) {
                    'shutdown' { & shutdown.exe /s /t 20 /c "Max: shutting down in 20 seconds. Say 'cancel shutdown' to stop." }
                    'restart' { & shutdown.exe /r /t 20 /c "Max: restarting in 20 seconds. Say 'cancel shutdown' to stop." }
                    'cancel' { & shutdown.exe /a 2>$null }
                    'sleep' { [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) }
                    default { return @{ ok = $false; result = "Unknown power action '$act'." } }
                }
                return @{ ok = $true; result = "Power: $act." }
            }
            'system_status' {
                $s = Get-MaxStats
                $top = (Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 |
                        ForEach-Object { "$($_.ProcessName) $([Math]::Round($_.WorkingSet64 / 1MB)) MB" }) -join ', '
                $bat = if ($null -ne $s.battery) { "battery $($s.battery)%$(if ($s.charging) { ' (charging)' })" } else { 'no battery (desktop)' }
                return @{ ok = $true; info = $true; result = "CPU $($s.cpu)%, RAM $($s.ram)% of $($s.ram_total_gb) GB, disk $($s.disk_used)% used ($($s.disk_free_gb) GB free), $bat, up $($s.uptime_h) hours, volume $($s.volume)%$(if ($s.muted) { ' muted' }). Biggest memory users: $top." }
            }
            'get_weather' { return Get-MaxWeather ([string]$a.city) }
            'get_news' { return Get-MaxNews ([string]$a.topic) }
            'wikipedia' { return Get-MaxWikipedia ([string]$a.query) }
            'take_note' {
                $f = Join-Path $MaxDataDir 'notes.md'
                Add-Content -Path $f -Value ("- [{0:yyyy-MM-dd HH:mm}] {1}" -f (Get-Date), ([string]$a.text).Trim()) -Encoding UTF8
                return @{ ok = $true; result = 'Noted.' }
            }
            'read_notes' {
                $f = Join-Path $MaxDataDir 'notes.md'
                if (-not (Test-Path $f)) { return @{ ok = $true; info = $true; result = 'No notes yet.' } }
                $lines = @(Get-Content $f -Encoding UTF8 | Where-Object { $_.Trim() } | Select-Object -Last 12)
                return @{ ok = $true; info = $true; result = "Latest notes:`n" + ($lines -join "`n") }
            }
            'open_notes' {
                $f = Join-Path $MaxDataDir 'notes.md'
                if (-not (Test-Path $f)) { Set-Content $f '# Max notes' -Encoding UTF8 }
                Start-Process notepad.exe "`"$f`""
                return @{ ok = $true; result = 'Opened your notes.' }
            }
            'clipboard_get' {
                $c = [string](Get-Clipboard -Raw)
                if (-not $c.Trim()) { return @{ ok = $true; info = $true; result = 'The clipboard is empty (or holds no text).' } }
                if ($c.Length -gt 2000) { $c = $c.Substring(0, 2000) + '...' }
                return @{ ok = $true; info = $true; result = "Clipboard text:`n$c" }
            }
            'clipboard_set' { Set-Clipboard -Value ([string]$a.text); return @{ ok = $true; result = 'Copied to clipboard.' } }
            'list_apps' {
                $q = ConvertTo-MaxKey ([string]$a.filter)
                $names = @(Get-MaxApps | ForEach-Object { $_.Name } | Where-Object { -not $q -or (ConvertTo-MaxKey $_).Contains($q) } | Sort-Object | Select-Object -First 60)
                return @{ ok = $true; info = $true; result = "Installed apps$(if ($q) { " matching '$q'" }): " + ($names -join ', ') }
            }
            default { return @{ ok = $false; result = "Unknown tool '$name'." } }
        }
    } catch {
        Write-MaxLog "tool $name failed: $($_.Exception.Message)"
        return @{ ok = $false; result = "That didn't work: $($_.Exception.Message)" }
    }
}
