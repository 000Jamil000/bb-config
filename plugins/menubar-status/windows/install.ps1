# Installs bb Status for the current Windows user:
#  - "bb Status.exe", a notification-area icon (state and count of the agents,
#    panel on hover, click to pin), started at sign-in from the Startup folder and visible
#    only while BB Desktop is running;
#  - the local helper (127.0.0.1:47615) that serves the panel from the files the
#    menubar-status plugin keeps in this folder; the icon starts and restarts it.
# Neither calls bb: the plugin writes the data here and picks replies up.
# Needs Python 3 on PATH and this PC enrolled in bb. The app is compiled here
# with the C# compiler that ships with Windows.
# Run:  powershell -ExecutionPolicy Bypass -File install.ps1      (-Remove to uninstall)
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'bb-menubar'
$exe = Join-Path $dir 'bb Status.exe'
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'bb Status.lnk'

Get-Process -Name 'bb Status' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object {
    $_.Kill(); $_.WaitForExit(5000) | Out-Null
}
if ($Remove) {
    Remove-Item -LiteralPath $shortcut -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $exe -ErrorAction SilentlyContinue
    Write-Output "removed: the icon and its autostart. Data stays in $dir; delete the folder to remove it too."
    return
}

$python = @('python3', 'python') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } |
    Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1
if (-not $python) { throw 'Python 3 was not found on PATH (the Microsoft Store stub does not count).' }
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "C# compiler not found: $csc" }

New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\macos\server.py'), (Join-Path $PSScriptRoot '..\macos\panel.html') -Destination $dir -Force
[IO.File]::WriteAllText((Join-Path $dir 'python'), $python.Source)
$token = Join-Path $dir 'token'
if (-not (Test-Path $token) -or (Get-Item $token).Length -eq 0) {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [IO.File]::WriteAllText($token, (($bytes | ForEach-Object { $_.ToString('x2') }) -join ''))
}

& $csc /nologo /target:winexe /optimize+ "/out:$exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'BBStatus.cs')
if ($LASTEXITCODE -ne 0) { throw 'bb Status did not compile.' }

$link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
$link.TargetPath = $exe
$link.WorkingDirectory = $dir
$link.Description = 'bb agent status in the notification area'
$link.Save()
Start-Process -FilePath $exe -WorkingDirectory $dir

# Windows 11 puts a new icon into the overflow behind "^". Hovering is the point of
# this one, so show it on the taskbar itself: the same switch as Settings >
# Personalization > Taskbar > Other system tray icons. Explorer creates the entry
# once the icon has appeared; when it has not yet, the user can flip the switch.
Start-Sleep -Seconds 4
Get-ChildItem 'HKCU:\Control Panel\NotifyIconSettings' -ErrorAction SilentlyContinue | ForEach-Object {
    if ((Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ExecutablePath -like '*\bb-menubar\bb Status.exe') {
        Set-ItemProperty -Path $_.PSPath -Name IsPromoted -Value 1 -Type DWord
        Write-Output 'the icon is set to stay visible on the taskbar'
    }
}

$status = (Join-Path $dir 'status.json') -replace '\\', '/'
Write-Output "installed: bb Status in the notification area, helper on 127.0.0.1:47615"
Write-Output "plugin settings:  bb plugin config menubar-status set hostId <this PC's host ID>"
Write-Output "                  bb plugin config menubar-status set filePath `"$status`""
