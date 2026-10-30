# Brise auf Windows aktualisieren oder installieren.
# Aufruf: irm https://raw.githubusercontent.com/magro07/brise/main/scripts/update.ps1 | iex
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$release = Invoke-RestMethod "https://api.github.com/repos/magro07/brise/releases/latest"
$asset = $release.assets | Where-Object { $_.name -like "*_x64_en-US.msi" } | Select-Object -First 1
if (-not $asset) { throw "Kein Windows-Installer in $($release.tag_name) gefunden." }
$msi = Join-Path $env:TEMP $asset.name
Write-Host "Lade Brise $($release.tag_name) ..."
Invoke-WebRequest $asset.browser_download_url -OutFile $msi
Get-Process brise -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Installiere ..."
$p = Start-Process msiexec.exe -ArgumentList "/i", "`"$msi`"", "/passive" -Wait -PassThru
Remove-Item $msi -ErrorAction SilentlyContinue
if ($p.ExitCode -ne 0) { throw "Installation fehlgeschlagen (Code $($p.ExitCode))." }
Write-Host "Fertig. Brise $($release.tag_name) ist installiert."
