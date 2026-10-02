# Installs (or updates) Chief Command Center from this folder. Run it with "Install Chief.cmd".
#
# 1. Checks Windows (64-bit, Windows 10 2004 or later).
# 2. Checks that the package in this folder is signed by the certificate in this folder, that the signature
#    is intact, and that the certificate is the one you were told about separately (its fingerprint comes
#    with your update key, never in this folder, so a tampered folder can't vouch for itself).
# 3. Trusts that certificate for app packages on this PC (one administrator prompt, first time only).
# 4. Installs the package, then opens the app.
#
# Nothing is downloaded and nothing else on the PC is changed. Kept to plain ASCII and Windows PowerShell 5.1.
# -CheckOnly runs steps 1 and 2 and changes nothing (for checking a setup folder before sending it).
# -Fingerprint <thumbprint> skips the question in step 2 (the value you were sent).
param([switch]$CheckOnly, [string]$Fingerprint = "")
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$identity = "ChiefCommandCenter"

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Stop-With($text) {
  Write-Host ""
  Write-Host $text -ForegroundColor Red
  exit 1
}

Step "Checking this PC"
if (-not [Environment]::Is64BitOperatingSystem) { Stop-With "Chief needs 64-bit Windows." }
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19041) { Stop-With "Chief needs Windows 10 version 2004 or later (this PC is build $build). Run Windows Update, then try again." }
Say "Windows build $build, 64-bit: fine."

$cerFile = Get-ChildItem -Path $here -Filter *.cer -File | Select-Object -First 1
if (-not $cerFile) { Stop-With "The certificate (.cer) is missing from this folder. Ask for the setup folder again." }
$packages = @(Get-ChildItem -Path $here -File | Where-Object { $_.Extension -in ".appx", ".msix" })
if ($packages.Count -ne 1) { Stop-With "This folder should hold exactly one Chief package (.appx). Ask for the setup folder again." }
$package = $packages[0]

Step "Checking the package signature"
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cerFile.FullName)
$signature = Get-AuthenticodeSignature -FilePath $package.FullName
if (-not $signature.SignerCertificate) { Stop-With "The package isn't signed. Don't install it; ask for the setup folder again." }
# Before the certificate is trusted Windows reports the chain as untrusted (UnknownError or NotTrusted); any
# other status (HashMismatch above all) means the package was changed after it was signed.
if (@("Valid", "UnknownError", "NotTrusted") -notcontains [string]$signature.Status) {
  Stop-With "The package's signature is broken ($($signature.Status)). Don't install it; ask for the setup folder again."
}
if ($signature.SignerCertificate.Thumbprint -ne $cert.Thumbprint) {
  Stop-With "The package wasn't signed with the certificate in this folder. Don't install it; ask for the setup folder again."
}
Say "Signed by $($cert.Subject)."
$expected = ($Fingerprint -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
if (-not $CheckOnly) {
  if (-not $expected) {
    Say ""
    Say "Certificate fingerprint: $($cert.Thumbprint)"
    Say "Compare it with the fingerprint you were sent together with your update key."
    $expected = ((Read-Host "Type the first 8 characters of the fingerprint you were sent") -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
  }
  if ($expected.Length -lt 8 -or -not $cert.Thumbprint.ToUpperInvariant().StartsWith($expected)) {
    Stop-With "That doesn't match this folder's certificate, so nothing was installed. Ask the person who sent it to check the fingerprint with you."
  }
  Say "Fingerprint matches."
}
if ($CheckOnly) {
  Say "Certificate fingerprint (send it with each update key): $($cert.Thumbprint)"
  Say ""
  Say "Check only: $($package.Name) is ready to install. Nothing was changed."
  exit 0
}

Step "Trusting the publisher certificate"
$trusted = Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
if ($trusted) {
  Say "Already trusted on this PC."
} else {
  Say "Windows will ask for permission once: this lets it install packages signed with this certificate."
  # Only the import runs as administrator; the path goes through an encoded command so spaces are safe.
  $command = "Import-Certificate -FilePath '" + $cerFile.FullName.Replace("'", "''") + "' -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  try {
    $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded
  } catch {
    Stop-With "Permission wasn't given, so nothing was installed. Run Install Chief again and choose Yes."
  }
  $trusted = Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
  if (-not $trusted) { Stop-With "The certificate couldn't be trusted (exit code $($p.ExitCode)). Nothing was installed." }
  Say "Trusted."
}
# Now that the certificate is trusted, the signature must verify completely.
$signature = Get-AuthenticodeSignature -FilePath $package.FullName
if ([string]$signature.Status -ne "Valid") { Stop-With "Windows doesn't accept the package's signature ($($signature.Status)). Nothing was installed." }

Step "Installing Chief"
$installed = Get-AppxPackage -Name $identity
try {
  # Updates in place and keeps your data; closes Chief first if it is open.
  Add-AppxPackage -Path $package.FullName -ForceApplicationShutdown
} catch {
  if ($_.Exception.Message -match "0x80073D06|higher version") {
    Say "A newer Chief is already installed; keeping it."
  } else {
    Stop-With ("Windows couldn't install the package: " + $_.Exception.Message)
  }
}
$now = Get-AppxPackage -Name $identity
if (-not $now) { Stop-With "Windows reported success, but Chief isn't installed. Restart the PC and run Install Chief again." }
if ($installed) { Say "Chief $($installed.Version) -> $($now.Version)." } else { Say "Chief $($now.Version) is installed." }

Step "Opening Chief"
Start-Process "shell:AppsFolder\$($now.PackageFamilyName)!$identity"
Say "Chief is starting. The first start sets things up and can take a minute."
Say ""
Say "One thing left, for updates:"
Say "  In Chief: Settings > Backup & updates > Update key: paste the key you were sent, then Save key."
Say "  After that, new versions show up as an 'Update available' card."
exit 0
