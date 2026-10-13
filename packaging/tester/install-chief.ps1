# Installs (or updates) Chief Command Center from this folder. Run it with "Install Chief.cmd".
#
# 1. Checks Windows (64-bit, Windows 10 2004 or later).
# 2. Checks that the package in this folder is signed by the certificate in this folder, that the signature
#    is intact, and that the certificate is the one you were told about separately (its fingerprint is sent by
#    message, never in this folder, so a tampered folder can't vouch for itself).
# 3. A new install asks which drive to use when more than one fixed NTFS drive has room (an update stays where
#    Chief is). Only the program goes there; Chief's data stays in the user's folders.
# 4. Trusts that certificate for app packages on this PC and, for a drive Windows doesn't keep apps on yet, sets
#    one up (one administrator prompt, first time only).
# 5. Installs the package, then opens the app.
#
# Nothing is downloaded and nothing else on the PC is changed. Kept to plain ASCII and Windows PowerShell 5.1.
# -CheckOnly runs steps 1 and 2 and changes nothing (for checking a setup folder before sending it).
# -Fingerprint <thumbprint> skips the question in step 2 (the whole value you were sent, 40 characters).
# -Drive <letter> skips the question in step 3. -Plan runs steps 1 to 3 and says what it would do, changing nothing.
param([switch]$CheckOnly, [string]$Fingerprint = "", [string]$Drive = "", [switch]$Plan)
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
    Say "Compare it with the fingerprint you were sent separately (by message)."
    $expected = ((Read-Host "Paste or type the whole fingerprint you were sent (40 characters; spaces don't matter)") -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
  }
  # All of it: a few characters can be matched by a certificate made to look alike.
  if ($expected.Length -ne 40 -or $cert.Thumbprint.ToUpperInvariant() -ne $expected) {
    Stop-With "That doesn't match this folder's certificate, so nothing was installed. Ask the person who sent it to check the fingerprint with you."
  }
  Say "Fingerprint matches."
}
if ($CheckOnly) {
  Say "Certificate fingerprint (send it by message, separately from the folder): $($cert.Thumbprint)"
  Say ""
  Say "Check only: $($package.Name) is ready to install. Nothing was changed."
  exit 0
}

# Where Windows keeps the app's program files (an "app volume": <drive>\WindowsApps, or C:\Program Files\WindowsApps).
# Chief's own data (chats, notes, settings) always stays in the user's folders, whatever the drive.
function Volume-On($letter) {
  Get-AppxVolume | Where-Object { -not $_.IsOffline -and ([string]$_.PackageStorePath).ToUpperInvariant().StartsWith($letter.ToUpperInvariant()) } | Select-Object -First 1
}
$installed = Get-AppxPackage -Name $identity
$systemDrive = $env:SystemDrive.Substring(0, 2).ToUpperInvariant()
$targetVolume = $null
$newVolumePath = ""
if ($installed) {
  # An update stays on the drive Chief is on (moving it is Settings > Apps > Installed apps > Move).
  $location = [string]$installed.InstallLocation
  $targetVolume = Get-AppxVolume | Where-Object { $location.ToUpperInvariant().StartsWith(([string]$_.PackageStorePath).ToUpperInvariant() + "\") } | Select-Object -First 1
  Say ""
  Say "Chief $($installed.Version) is installed on $($location.Substring(0, 2)); it will be updated there."
} else {
  Step "Choosing where to install"
  $minFree = 6GB
  $drives = @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and [string]$_.DriveType -eq "Fixed" -and $_.DriveFormat -eq "NTFS" -and $_.AvailableFreeSpace -ge $minFree })
  $letters = @($drives | ForEach-Object { $_.Name.Substring(0, 2).ToUpperInvariant() })
  if ($Drive) {
    $letter = ($Drive.Trim().TrimEnd("\").TrimEnd(":") + ":").ToUpperInvariant()
    if ($letters -notcontains $letter) { Stop-With "Drive $letter can't take Chief (it must be a fixed NTFS drive with at least 6 GB free)." }
  } elseif ($letters.Count -eq 0) {
    Stop-With "No drive has the 6 GB Chief needs to install. Free up some space, then run Install Chief again."
  } elseif ($letters.Count -eq 1) {
    $letter = $letters[0]
  } else {
    # The suggestion: the Windows drive if it has room, otherwise the drive with the most free space.
    $suggested = if ($letters -contains $systemDrive) { $systemDrive } else { ($drives | Sort-Object AvailableFreeSpace -Descending | Select-Object -First 1).Name.Substring(0, 2).ToUpperInvariant() }
    Say "Chief's program takes about 3 GB. Your chats, notes and settings stay in your user folder either way."
    for ($i = 0; $i -lt $drives.Count; $i++) {
      $d = $drives[$i]
      $name = if ($d.VolumeLabel) { " " + $d.VolumeLabel } else { "" }
      $note = if ($letters[$i] -eq $systemDrive) { "  (the Windows drive)" } else { "" }
      Say ("  {0}) {1}{2}, {3} GB free{4}" -f ($i + 1), $letters[$i], $name, [math]::Floor($d.AvailableFreeSpace / 1GB), $note)
    }
    $answer = (Read-Host "Install on which drive? Type its number or letter, or press Enter for $suggested").Trim()
    if (-not $answer) {
      $letter = $suggested
    } elseif ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $letters.Count) {
      $letter = $letters[[int]$answer - 1]
    } else {
      $letter = ($answer.TrimEnd("\").TrimEnd(":") + ":").ToUpperInvariant()
      if ($letters -notcontains $letter) { Stop-With "$answer isn't one of the drives listed, so nothing was installed. Run Install Chief again." }
    }
  }
  $targetVolume = Volume-On $letter
  if (-not $targetVolume -and $letter -ne $systemDrive) { $newVolumePath = "$letter\WindowsApps" }
  Say "Installing on $letter."
}

$trusted = Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
if ($Plan) {
  Say ""
  Say ("Plan only, nothing changed: certificate " + $(if ($trusted) { "already trusted" } else { "to be trusted" }) + "; app volume " + $(if ($newVolumePath) { "to be added at $newVolumePath" } elseif ($targetVolume) { $targetVolume.PackageStorePath } else { "Windows' default" }) + ".")
  exit 0
}

Step "Getting Windows' permission"
# Everything that needs an administrator goes in one prompt: trusting the certificate, and (for another drive) letting
# Windows keep apps there. The administrator side gets the certificate's bytes (checked above), not the file, which
# could be swapped while the prompt is up, and checks its fingerprint again. Values travel base64-encoded, so no
# quote in a path or name (curly ones included) can change the command.
function Text64($text) { "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) + "')))" }
$admin = @()
if ($trusted) { Say "The certificate is already trusted on this PC." } else {
  $bytes = [Convert]::ToBase64String($cert.RawData)
  $admin += "`$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(,[Convert]::FromBase64String('$bytes'))"
  $admin += "if (`$c.Thumbprint -ne '$($cert.Thumbprint)') { exit 5 }"
  $admin += "`$s = New-Object System.Security.Cryptography.X509Certificates.X509Store('TrustedPeople', 'LocalMachine'); `$s.Open('ReadWrite'); `$s.Add(`$c); `$s.Close()"
}
if ($newVolumePath) {
  $admin += "`$v = Add-AppxVolume -Path $(Text64 $newVolumePath); if (`$v -and `$v.IsOffline) { Mount-AppxVolume -Volume `$v }"
}
if ($admin.Count) {
  Say "Windows will ask for permission once: this lets it install packages signed with this certificate$(if ($newVolumePath) { ' and keep apps on ' + $newVolumePath.Substring(0, 2) })."
  $command = "`$ErrorActionPreference = 'Stop'; " + ($admin -join "; ")
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  try {
    $p = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded
  } catch {
    Stop-With "Permission wasn't given, so nothing was installed. Run Install Chief again and choose Yes."
  }
  $trusted = Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
  if (-not $trusted) { Stop-With "The certificate couldn't be trusted (exit code $($p.ExitCode)). Nothing was installed." }
  if ($newVolumePath) {
    $targetVolume = Volume-On $newVolumePath.Substring(0, 2)
    if (-not $targetVolume) { Stop-With "Windows couldn't set up $newVolumePath for apps (exit code $($p.ExitCode)). Nothing was installed; run Install Chief again and pick another drive." }
  }
  Say "Done."
}
# Now that the certificate is trusted, the signature must verify completely.
$signature = Get-AuthenticodeSignature -FilePath $package.FullName
if ([string]$signature.Status -ne "Valid") { Stop-With "Windows doesn't accept the package's signature ($($signature.Status)). Nothing was installed." }

Step "Installing Chief"
try {
  # Updates in place and keeps your data; closes Chief first if it is open.
  if ($targetVolume) {
    Add-AppxPackage -Path $package.FullName -ForceApplicationShutdown -Volume $targetVolume
  } else {
    Add-AppxPackage -Path $package.FullName -ForceApplicationShutdown
  }
} catch {
  if ($_.Exception.Message -match "0x80073D06|higher version") {
    Say "A newer Chief is already installed; keeping it."
  } else {
    Stop-With ("Windows couldn't install the package: " + $_.Exception.Message)
  }
}
$now = Get-AppxPackage -Name $identity
if (-not $now) { Stop-With "Windows reported success, but Chief isn't installed. Restart the PC and run Install Chief again." }
$on = ([string]$now.InstallLocation).Substring(0, 2)
if ($installed) { Say "Chief $($installed.Version) -> $($now.Version), on $on." } else { Say "Chief $($now.Version) is installed on $on." }

Step "Opening Chief"
Start-Process "shell:AppsFolder\$($now.PackageFamilyName)!$identity"
Say "Chief is starting. The first start sets things up and can take a minute."
Say ""
Say "New versions show up in Chief as an 'Update available' card; nothing else to set up."
exit 0
