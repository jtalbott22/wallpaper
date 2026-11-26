<#
.SYNOPSIS
  Builds the single-file Aether.exe: .NET and the page built in, installs itself.

.EXAMPLE
  .\build-exe.ps1                 # writes windows\dist\Aether.exe
  .\build-exe.ps1 -Output C:\tmp  # somewhere else

  Run the exe from anywhere (Downloads, a USB stick) and it offers to install
  itself for the current user; Settings > Apps removes it. Flags:
    Aether.exe --install [--start-at-login]   install without asking
    Aether.exe --uninstall [--quiet]          remove it (what Settings > Apps runs)
    Aether.exe --no-install                   just run, don't offer to install
#>
param(
    [string]$Output = (Join-Path $PSScriptRoot 'dist')
)
$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'Aether.csproj'
$stage = Join-Path $PSScriptRoot 'bin\bundle'   # publish here, then take only the exe

& dotnet publish $project -c Release -p:PublishSingleFile=true -o $stage --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }

New-Item -ItemType Directory -Force $Output | Out-Null
$exe = Join-Path $Output 'Aether.exe'
Copy-Item (Join-Path $stage 'Aether.exe') $exe -Force
'{0}  ({1:N0} MB)' -f $exe, ((Get-Item $exe).Length / 1MB)
