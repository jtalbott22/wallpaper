<#
.SYNOPSIS
  Builds Aether for Windows and installs it for the current user.

.EXAMPLE
  .\install.ps1                  # build, install to %LOCALAPPDATA%\Programs\Aether, start it
  .\install.ps1 -StartAtLogin    # ...and start it at every login
  .\install.ps1 -SelfContained   # bundle .NET, for machines without the .NET 8 Desktop Runtime
  .\install.ps1 -Uninstall       # stop it, remove it, its Start menu entry and the login entry
#>
param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\Aether'),
    [switch]$StartAtLogin,
    [switch]$SelfContained,
    [switch]$NoStart,
    [switch]$NoShortcut,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Aether.lnk'   # Start menu

function Stop-Aether {
    $running = Get-Process -Name Aether -ErrorAction SilentlyContinue
    if (-not $running) { return }
    # ask it to close cleanly (any copy's --exit reaches the running one), then make sure
    $exe = $running[0].Path
    if ($exe) { Start-Process $exe -ArgumentList '--exit' -Wait }
    $running | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
    Get-Process -Name Aether -ErrorAction SilentlyContinue | Stop-Process -Force
}

if ($Uninstall) {
    Stop-Aether
    Remove-ItemProperty -Path $runKey -Name Aether -ErrorAction SilentlyContinue
    Remove-Item $shortcut -ErrorAction SilentlyContinue
    if (Test-Path $Destination) { Remove-Item -Recurse -Force $Destination }
    Write-Host "Removed Aether. Settings stay in $env:APPDATA\Aether and the log in $env:LOCALAPPDATA\Aether."
    return
}

$project = Join-Path $PSScriptRoot 'Aether.csproj'
$publishArgs = @('publish', $project, '-c', 'Release', '-o', $Destination, '--nologo')
if ($SelfContained) { $publishArgs += @('-r', 'win-x64', '--self-contained', 'true') }

Stop-Aether
& dotnet @publishArgs
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }

$exe = Join-Path $Destination 'Aether.exe'
if (-not $NoShortcut) {
    # the Start menu entry shows the exe's icon, the Aether mark
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $Destination
    $lnk.IconLocation = "$exe,0"
    $lnk.Description = 'Aether animated wallpaper'
    $lnk.Save()
    Write-Host 'Added Aether to the Start menu.'
}
if ($StartAtLogin) {
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name Aether -Value "`"$exe`""
    Write-Host 'Aether will start at login.'
}
Write-Host "Installed to $Destination"
if (-not $NoStart) { Start-Process $exe }
