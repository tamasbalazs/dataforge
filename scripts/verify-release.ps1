# Verify a downloaded DataForge release on Windows: Authenticode signature of
# the installers and their SHA-256 checksums (SHA256SUMS).
#   powershell -ExecutionPolicy Bypass -File verify-release.ps1 [-Folder .]
param([string]$Folder = ".")
$ErrorActionPreference = "Stop"
Set-Location $Folder
if (-not (Test-Path SHA256SUMS)) { Write-Error "SHA256SUMS not found"; exit 1 }
$checked = 0
foreach ($line in Get-Content SHA256SUMS) {
  $hash, $name = $line -split '\s+', 2
  if (-not (Test-Path $name)) { continue }
  $actual = (Get-FileHash -Algorithm SHA256 $name).Hash.ToLower()
  if ($actual -ne $hash) { Write-Error "$name : checksum mismatch - do not install"; exit 1 }
  if ($name -match '\.(exe|msi)$') {
    $sig = Get-AuthenticodeSignature $name
    if ($sig.Status -ne 'Valid') { Write-Error "$name : Authenticode signature is $($sig.Status) - do not install"; exit 1 }
    Write-Host "OK $name (signed by $($sig.SignerCertificate.Subject))"
  } else { Write-Host "OK $name" }
  $checked++
}
if ($checked -eq 0) { Write-Error "none of the files listed in SHA256SUMS is here"; exit 1 }
Write-Host "$checked file(s) verified"
