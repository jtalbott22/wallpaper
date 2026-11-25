<#
.SYNOPSIS
  Regenerates Aether.ico (the exe, taskbar and Start menu icon) from the
  mark drawn in src/Icons.cs. Run it after changing the mark; the .ico is
  committed, so a normal build doesn't need it.
#>
$ErrorActionPreference = 'Stop'
# Windows PowerShell's System.Drawing is the simplest to compile against, and every Windows has it
if ($PSVersionTable.PSEdition -eq 'Core') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
    exit $LASTEXITCODE
}
Add-Type -Path (Join-Path $PSScriptRoot 'src\Icons.cs') -ReferencedAssemblies System.Drawing
$out = Join-Path $PSScriptRoot 'Aether.ico'
[Aether.Icons]::WriteIco($out, [int[]](16, 20, 24, 32, 40, 48, 64, 96, 128, 256))
Write-Host $out
