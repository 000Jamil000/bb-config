# Installs bb Status for the current Windows user:
#  - "bb Status.exe": a strip on the taskbar with the agents by state and every
#    account's limits (-Ui strip, the default), a notification-area icon (-Ui tray),
#    or both (-Ui both); the panel opens when either is pointed at, a click pins it.
#    Started at sign-in from the Startup folder, visible only while BB Desktop runs;
#  - the local helper (127.0.0.1:47615) that serves the panel from the files the
#    menubar-status plugin keeps in this folder; the program starts and restarts it.
# Neither calls bb: the plugin writes the data here and picks replies up.
#
# Needs Python 3 on PATH, this PC enrolled in bb, and the WebView2 Runtime (part of
# Windows 11; https://developer.microsoft.com/microsoft-edge/webview2 for Windows 10).
# The program is compiled here with the C# compiler that ships with Windows. The
# panel is a WebView2; its three SDK libraries (Microsoft, redistributable) are
# taken from the NuGet package named below, checked against the SHA-256 below.
# Without Internet access pass the downloaded package: -WebView2Package <file>.
#
# Run:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Ui strip|tray|both]     (-Remove to uninstall)
param([ValidateSet('strip', 'tray', 'both')][string]$Ui = 'strip', [string]$WebView2Package = '', [switch]$Remove)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'bb-menubar'
$exe = Join-Path $dir 'bb Status.exe'
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'bb Status.lnk'
$sdkVersion = '1.0.4314.35'
$sdkSha256 = '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'
$sdkUrl = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"

Get-Process -Name 'bb Status' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object {
    $_.Kill(); $_.WaitForExit(5000) | Out-Null
}
# Its helpers: one stayed behind whenever an earlier build of the program was stopped rather than closed.
$served = Join-Path $dir 'server.py'
Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($served) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if ($Remove) {
    Remove-Item -LiteralPath $shortcut -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $exe -ErrorAction SilentlyContinue
    Write-Output "removed: the program and its autostart. Data stays in $dir; delete the folder to remove it too."
    return
}

$python = @('python3', 'python') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } |
    Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1
if (-not $python) { throw 'Python 3 was not found on PATH (the Microsoft Store stub does not count).' }
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "C# compiler not found: $csc" }

New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\macos\server.py'), (Join-Path $PSScriptRoot '..\macos\panel.html') -Destination $dir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'icons') -Destination $dir -Recurse -Force
[IO.File]::WriteAllText((Join-Path $dir 'python'), $python.Source)
[IO.File]::WriteAllText((Join-Path $dir 'ui'), $Ui)
$token = Join-Path $dir 'token'
if (-not (Test-Path $token) -or (Get-Item $token).Length -eq 0) {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [IO.File]::WriteAllText($token, (($bytes | ForEach-Object { $_.ToString('x2') }) -join ''))
}

# The WebView2 SDK libraries next to the program: fetched once per SDK version.
$native = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$libraries = [ordered]@{
    'Microsoft.Web.WebView2.Core.dll'     = 'lib/net462/Microsoft.Web.WebView2.Core.dll'
    'Microsoft.Web.WebView2.WinForms.dll' = 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
    'WebView2Loader.dll'                  = "runtimes/$native/native/WebView2Loader.dll"
}
$marker = Join-Path $dir 'webview2-sdk'
$have = (Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq "$sdkVersion $native") -and
    -not ($libraries.Keys | Where-Object { -not (Test-Path (Join-Path $dir $_)) })
if (-not $have) {
    $package = $WebView2Package
    $temporary = $null
    if (-not $package) {
        $temporary = Join-Path $dir 'webview2-sdk.download'
        $package = $temporary
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $sdkUrl -OutFile $package -UseBasicParsing
        } catch {
            # Some machines refuse TLS to Windows' own client; Node.js, which bb needs anyway, has its own.
            $node = Get-Command node -ErrorAction SilentlyContinue
            if (-not $node) { throw "The WebView2 SDK could not be downloaded ($($_.Exception.Message)). Download $sdkUrl and pass -WebView2Package <file>." }
            & $node.Source -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync(process.argv[2],Buffer.from(b))).catch(e=>{console.error(String(e));process.exit(1)})" $sdkUrl $package
            if ($LASTEXITCODE -ne 0) { throw "The WebView2 SDK could not be downloaded. Download $sdkUrl and pass -WebView2Package <file>." }
        }
    }
    $actual = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $sdkSha256) { throw "The WebView2 SDK package does not match the expected SHA-256 ($actual); nothing was installed from it." }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($package)
    try {
        foreach ($name in $libraries.Keys) {
            $entry = $zip.GetEntry($libraries[$name])
            if (-not $entry) { throw "The WebView2 SDK package has no $($libraries[$name])." }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $dir $name), $true)
        }
    } finally { $zip.Dispose() }
    if ($temporary) { Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue }
    [IO.File]::WriteAllText($marker, "$sdkVersion $native")
}

& $csc /nologo /target:winexe /optimize+ "/out:$exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll `
    "/r:$(Join-Path $dir 'Microsoft.Web.WebView2.Core.dll')" "/r:$(Join-Path $dir 'Microsoft.Web.WebView2.WinForms.dll')" (Join-Path $PSScriptRoot 'BBStatus.cs')
if ($LASTEXITCODE -ne 0) { throw 'bb Status did not compile.' }

# The first version of this client showed the panel in an Edge window of its own profile: no longer used.
$oldProfile = Join-Path $dir 'edge-profile'
if (Test-Path $oldProfile) { Remove-Item -LiteralPath $oldProfile -Recurse -Force -ErrorAction SilentlyContinue }

$link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
$link.TargetPath = $exe
$link.WorkingDirectory = $dir
$link.Description = 'bb agent status on the taskbar'
$link.Save()
Start-Process -FilePath $exe -WorkingDirectory $dir

# Windows 11 puts a new notification-area icon into the overflow behind "^". Pointing is
# the point of it, so show it on the taskbar itself: the same switch as Settings >
# Personalization > Taskbar > Other system tray icons. Explorer creates the entry once
# the icon has appeared; when it has not yet, the user can flip the switch.
if ($Ui -ne 'strip') {
    Start-Sleep -Seconds 4
    Get-ChildItem 'HKCU:\Control Panel\NotifyIconSettings' -ErrorAction SilentlyContinue | ForEach-Object {
        if ((Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ExecutablePath -like '*\bb-menubar\bb Status.exe') {
            Set-ItemProperty -Path $_.PSPath -Name IsPromoted -Value 1 -Type DWord
            Write-Output 'the icon is set to stay visible on the taskbar'
        }
    }
}

$status = (Join-Path $dir 'status.json') -replace '\\', '/'
Write-Output "installed: bb Status ($Ui), helper on 127.0.0.1:47615"
Write-Output "plugin settings:  bb plugin config menubar-status set hostId <this PC's host ID>"
Write-Output "                  bb plugin config menubar-status set filePath `"$status`""
