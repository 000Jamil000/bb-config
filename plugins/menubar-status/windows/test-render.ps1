# Draws the strip for made-up data, without touching the live status.json and usage.json:
# what the limits block looks like with a 5-hour and a weekly limit, limit resets on hand,
# several machines, a reset ten minutes away, a used-up week, and with nothing to report.
# Writes PNG files (dark and light taskbar) and prints their paths; look at them.
# Run:  powershell -ExecutionPolicy Bypass -File test-render.ps1 [-Out <folder>]
param([string]$Out = (Join-Path $env:TEMP 'bb-status-render'))
$ErrorActionPreference = 'Stop'
$exe = Join-Path $env:LOCALAPPDATA 'bb-menubar\bb Status.exe'
if (-not (Test-Path $exe)) { throw 'bb Status is not installed: run install.ps1 first.' }
New-Item -ItemType Directory -Force $Out | Out-Null
$now = [DateTimeOffset]::UtcNow
$ms = $now.ToUnixTimeMilliseconds()
function In([double]$minutes) { $now.AddMinutes($minutes).ToString('o') }
$cases = [ordered]@{
    # Claude on two machines with a 5-hour limit about to reset and two resets on hand; Codex with both limits.
    'limits' = @{
        status = @{ generatedAt = $ms; counts = @{ needs = 1; running = 2; unread = 0; error = 0 }; items = @() }
        usage  = @{ at = $ms; available = $true; accounts = @(
            @{ provider = 'claude-code'; hosts = @('desktop', 'server'); plan = 'Max'; status = 'ok'; resets = 2; windows = @(
                @{ label = 'Current session'; kind = 'five-hour'; usedPercent = 93; resetsAt = (In 10) },
                @{ label = 'Weekly limit'; kind = 'weekly'; usedPercent = 40; resetsAt = (In 4000) }) },
            @{ provider = 'codex'; hosts = @('desktop'); plan = 'Pro'; status = 'ok'; resets = 0; windows = @(
                @{ label = 'Five-hour limit'; kind = 'five-hour'; usedPercent = 35; resetsAt = (In 170) },
                @{ label = 'Weekly limit'; kind = 'weekly'; usedPercent = 64; resetsAt = (In 6000) }) }) }
    }
    # The week is used up: the timer is the week's reset on a red pill; an agent failed.
    'used-up' = @{
        status = @{ generatedAt = $ms; counts = @{ needs = 0; running = 0; unread = 3; error = 1 }; items = @() }
        usage  = @{ at = $ms; available = $true; accounts = @(
            @{ provider = 'claude-code'; hosts = @('desktop'); plan = 'Pro'; status = 'ok'; resets = 0; windows = @(
                @{ label = 'Current session'; kind = 'five-hour'; usedPercent = 100; resetsAt = (In 95) },
                @{ label = 'Weekly limit'; kind = 'weekly'; usedPercent = 100; resetsAt = (In 1500) }) }) }
    }
    # Only weekly limits are known (no 5-hour figure from the service): no bar is invented for it.
    'week-only' = @{
        status = @{ generatedAt = $ms; counts = @{ needs = 0; running = 0; unread = 0; error = 0 }; items = @() }
        usage  = @{ at = $ms; available = $true; accounts = @(
            @{ provider = 'claude-code'; hosts = @('desktop'); plan = 'Ultra'; status = 'ok'; resets = 0; windows = @(
                @{ label = 'Weekly limit'; kind = 'weekly'; usedPercent = 43; resetsAt = (In 5300) },
                @{ label = 'Fable'; kind = 'model'; usedPercent = 61; resetsAt = (In 5300) }) },
            @{ provider = 'codex'; hosts = @('desktop'); plan = 'Prolite'; status = 'ok'; resets = 0; windows = @(
                @{ label = 'Weekly limit'; kind = 'weekly'; usedPercent = 67; resetsAt = (In 5900) }) }) }
    }
    # The plugin has not written for a long time: no agents, no limits shown as if current.
    'stale' = @{
        status = @{ generatedAt = $ms - 3600000; counts = @{ needs = 2; running = 1; unread = 0; error = 0 }; items = @() }
        usage  = @{ at = $ms - 3600000; available = $true; accounts = @(
            @{ provider = 'codex'; hosts = @('desktop'); plan = 'Pro'; status = 'ok'; resets = 0; windows = @(
                @{ label = 'Weekly limit'; kind = 'weekly'; usedPercent = 64; resetsAt = (In 6000) }) }) }
    }
}
$utf8 = New-Object System.Text.UTF8Encoding $false
foreach ($name in $cases.Keys) {
    $folder = Join-Path $Out $name
    New-Item -ItemType Directory -Force $folder | Out-Null
    [IO.File]::WriteAllText((Join-Path $folder 'status.json'), ($cases[$name].status | ConvertTo-Json -Depth 8), $utf8)
    [IO.File]::WriteAllText((Join-Path $folder 'usage.json'), ($cases[$name].usage | ConvertTo-Json -Depth 8), $utf8)
    foreach ($theme in 'dark', 'light') {
        $picture = Join-Path $Out "$name-$theme.png"
        Remove-Item -LiteralPath $picture -ErrorAction SilentlyContinue
        $run = Start-Process -FilePath $exe -ArgumentList '--render', "`"$folder`"", "`"$picture`"", $theme -Wait -PassThru
        if ($run.ExitCode -ne 0 -or -not (Test-Path $picture)) { throw "render failed for $name ($theme)" }
        Write-Output $picture
    }
}
