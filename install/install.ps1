#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Rafiki Code installer for Windows.

.DESCRIPTION
    Downloads the release archive for this machine, verifies it against the
    SHA256SUMS published with the release, and installs rafikicode.exe into a
    user owned directory on the PATH. No administrator rights are needed.

    This is the Windows counterpart of install/install.sh, which is a POSIX
    shell script and runs on Windows only under WSL, Git Bash or Cygwin.

    The binary is installed into %USERPROFILE%\.rafikicode\bin because
    "rafikicode upgrade" recognises that directory as the installer's own
    channel and updates in place. Installing elsewhere still works, but
    upgrade may not detect how the program was installed.

.PARAMETER Version
    Install this version instead of the newest release, with or without a
    leading "v". Also read from the VERSION environment variable.

.PARAMETER Prefix
    Install into this directory instead of %USERPROFILE%\.rafikicode\bin. Also
    read from RAFIKICODE_INSTALL_DIR.

.PARAMETER Baseline
    Force the baseline build, which does not require AVX2. Use this on an older
    x64 processor if the installed program fails to start.

.PARAMETER NoModifyPath
    Do not change the user PATH; print the directory to add instead.

.PARAMETER DryRun
    Resolve the version and report what would happen. Download nothing.

.EXAMPLE
    irm https://get.rafikiai.io/install.ps1 | iex

.EXAMPLE
    .\install.ps1 -Version 0.1.7 -Baseline
#>
[CmdletBinding()]
param(
    [string] $Version,
    [string] $Prefix,
    [switch] $Baseline,
    [switch] $NoModifyPath,
    [switch] $DryRun
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 prints a progress bar for every byte of a download,
# which makes a 60 MB fetch many times slower than it needs to be.
$ProgressPreference = 'SilentlyContinue'

$App = 'rafikicode'
$BinName = "$App.exe"
$Owner = 'paneotech-dev'
$Repo = 'rafiki-code-cli'
$Checksums = 'SHA256SUMS'

function Get-EnvOrDefault([string] $Name, [string] $Default) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value
}

$ReleaseApi = Get-EnvOrDefault 'RAFIKICODE_RELEASE_API' "https://api.github.com/repos/$Owner/$Repo"
$ReleaseBase = Get-EnvOrDefault 'RAFIKICODE_RELEASE_BASE' "https://github.com/$Owner/$Repo/releases"

if ([string]::IsNullOrWhiteSpace($Version)) { $Version = Get-EnvOrDefault 'VERSION' '' }
if ([string]::IsNullOrWhiteSpace($Prefix)) {
    $Prefix = Get-EnvOrDefault 'RAFIKICODE_INSTALL_DIR' (Join-Path (Join-Path $env:USERPROFILE '.rafikicode') 'bin')
}

function Write-Step([string] $Message) { Write-Host $Message }
function Write-Note([string] $Message) { Write-Host $Message -ForegroundColor DarkGray }
function Fail([string] $Message) {
    Write-Host "Error: $Message" -ForegroundColor Red
    # exit still runs the finally block that removes the scratch directory.
    exit 1
}

# Windows PowerShell 5.1 does not negotiate TLS 1.2 by default on every build,
# and github.com refuses anything older.
try {
    $tls12 = [Net.SecurityProtocolType]::Tls12
    if (([Net.ServicePointManager]::SecurityProtocol -band $tls12) -ne $tls12) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor $tls12
    }
} catch {
    Write-Note 'Could not raise the TLS version; continuing with the default.'
}

# Architecture of the operating system, not of this PowerShell process.
# PROCESSOR_ARCHITECTURE reports the process architecture, so an x86 or x64
# PowerShell on an ARM64 machine reports the wrong answer.
function Get-OsArchitecture {
    try {
        $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        switch ($osArch) {
            'X64'   { return 'x64' }
            'Arm64' { return 'arm64' }
            'X86'   { return 'x86' }
            'Arm'   { return 'arm' }
        }
    } catch {
        # .NET older than 4.7.1 has no RuntimeInformation; fall through.
    }
    $raw = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($raw)) { $raw = $env:PROCESSOR_ARCHITECTURE }
    switch ("$raw".ToUpperInvariant()) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        'X86'   { return 'x86' }
        default { return "$raw".ToLowerInvariant() }
    }
}

$arch = Get-OsArchitecture
if ($arch -eq 'x86' -or $arch -eq 'arm') {
    Fail "32 bit Windows ($arch) is not supported. Releases are built for x64 and arm64 only."
}
if ($arch -ne 'x64' -and $arch -ne 'arm64') {
    Fail "Unsupported architecture: $arch. Releases are built for x64 and arm64 only."
}

# AVX2 decides between the normal and the baseline x64 build. The check is only
# available on PowerShell 7 and later, where System.Runtime.Intrinsics exists.
# On Windows PowerShell 5.1 the normal build is chosen and the smoke test at the
# end tells the user to rerun with -Baseline if it does not start.
$variant = ''
$avx2Known = $false
if ($Baseline) {
    $variant = 'baseline'
    $avx2Known = $true
} elseif ($arch -eq 'x64') {
    try {
        $avx2Type = [Type]::GetType('System.Runtime.Intrinsics.X86.Avx2')
        if ($null -ne $avx2Type) {
            $avx2Known = $true
            if (-not $avx2Type::IsSupported) { $variant = 'baseline' }
        }
    } catch {
        $avx2Known = $false
    }
}

$target = "windows-$arch"
if ($variant -ne '') { $target = "$target-$variant" }
$asset = "$App-$target.zip"

# Version resolution.
if ([string]::IsNullOrWhiteSpace($Version)) {
    $latestUrl = "$ReleaseApi/releases/latest"
    try {
        $release = Invoke-RestMethod -Uri $latestUrl -Headers @{
            'Accept'     = 'application/vnd.github+json'
            'User-Agent' = $App
        } -UseBasicParsing
    } catch {
        Fail "Could not read the latest version from $latestUrl : $($_.Exception.Message)"
    }
    if (-not $release.tag_name) { Fail "The latest release at $latestUrl has no tag name." }
    $resolved = "$($release.tag_name)" -replace '^v', ''
} else {
    $resolved = "$Version" -replace '^v', ''
}

$archiveUrl = "$ReleaseBase/download/v$resolved/$asset"
$sumsUrl = "$ReleaseBase/download/v$resolved/$Checksums"
$targetPath = Join-Path $Prefix $BinName

if ($DryRun) {
    Write-Host "dry run: $App $resolved for $target"
    Write-Host "  archive:   $archiveUrl"
    Write-Host "  checksums: $sumsUrl"
    Write-Host "  install:   $targetPath"
    exit 0
}

# Already installed at this version.
if (Test-Path -LiteralPath $targetPath) {
    $installed = ''
    try { $installed = (& $targetPath --version 2>$null | Select-Object -First 1) } catch { $installed = '' }
    if ("$installed".Trim() -eq $resolved) {
        Write-Note "Version $resolved is already installed at $targetPath"
        exit 0
    }
    if (-not [string]::IsNullOrWhiteSpace($installed)) {
        Write-Note "Installed version: $($installed.Trim())"
    }
}

Write-Step ''
Write-Step "Installing $App version $resolved for $target"

$work = Join-Path ([IO.Path]::GetTempPath()) "$App-install-$PID"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
    # Checksums first, so a version that was never published fails before a
    # 60 MB download rather than after it.
    $sumsPath = Join-Path $work $Checksums
    try {
        Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath -UseBasicParsing
    } catch {
        Fail "Could not download $Checksums for v$resolved from $sumsUrl. Is the version published?"
    }

    $expected = ''
    foreach ($line in (Get-Content -LiteralPath $sumsPath)) {
        $m = [regex]::Match($line.Trim(), '^([0-9a-fA-F]{64})\s+\*?(.+)$')
        if ($m.Success -and ($m.Groups[2].Value.Trim() -eq $asset)) {
            $expected = $m.Groups[1].Value.ToLowerInvariant()
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($expected)) {
        Fail "$Checksums for v$resolved has no entry for $asset."
    }

    $zipPath = Join-Path $work $asset
    try {
        Invoke-WebRequest -Uri $archiveUrl -OutFile $zipPath -UseBasicParsing
    } catch {
        Fail "Download failed: $archiveUrl : $($_.Exception.Message)"
    }

    $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Fail "Checksum mismatch for $asset : expected $expected, got $actual. Nothing was installed."
    }
    Write-Note 'Checksum verified'

    # Clear the "downloaded from the internet" mark so Windows does not warn on
    # the extracted file. Invoke-WebRequest does not set it, so this is normally
    # a no-op; it matters when the archive came from a browser.
    try { Unblock-File -LiteralPath $zipPath } catch { }

    $extract = Join-Path $work 'unpacked'
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extract)
    } catch {
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extract -Force
    }

    $source = Join-Path $extract $BinName
    if (-not (Test-Path -LiteralPath $source)) {
        Fail "The archive does not contain $BinName."
    }
    try { Unblock-File -LiteralPath $source } catch { }

    New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
    $staged = "$targetPath.new"
    Copy-Item -LiteralPath $source -Destination $staged -Force

    # Windows refuses to overwrite a running executable, so the old file is
    # renamed out of the way first and removed afterwards if it is free.
    if (Test-Path -LiteralPath $targetPath) {
        $old = "$targetPath.old"
        if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
        Move-Item -LiteralPath $targetPath -Destination $old -Force
    }
    Move-Item -LiteralPath $staged -Destination $targetPath -Force
    $leftover = "$targetPath.old"
    if (Test-Path -LiteralPath $leftover) {
        Remove-Item -LiteralPath $leftover -Force -ErrorAction SilentlyContinue
    }
} finally {
    if (Test-Path -LiteralPath $work) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Note "Installed $App at $targetPath"

# PATH. The user PATH is read straight out of the registry without expanding
# %VARIABLE% references: [Environment]::GetEnvironmentVariable expands them, and
# writing the expanded value back would freeze another program's directory into
# the user's PATH.
function Add-ToUserPath([string] $Directory) {
    $key = $null
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        if ($null -eq $key) { return 'failed' }
        $kind = 'String'
        $current = ''
        $existing = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $existing) { $current = "$existing" }
        try { $kind = $key.GetValueKind('Path').ToString() } catch { $kind = 'String' }

        $parts = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        foreach ($part in $parts) {
            if ($part.TrimEnd('\').Trim() -ieq $Directory.TrimEnd('\')) { return 'present' }
        }

        $updated = if ($parts.Count -eq 0) { $Directory } else { (($parts + $Directory) -join ';') }
        $valueKind = if ($kind -eq 'ExpandString') {
            [Microsoft.Win32.RegistryValueKind]::ExpandString
        } else {
            [Microsoft.Win32.RegistryValueKind]::String
        }
        $key.SetValue('Path', $updated, $valueKind)
        return 'added'
    } catch {
        return 'failed'
    } finally {
        if ($null -ne $key) { $key.Close() }
    }
}

# Tell the shell and Explorer that the environment changed, otherwise a new
# terminal started from the existing Explorer still has the old PATH.
function Publish-EnvironmentChange {
    try {
        $type = 'Rafiki.EnvBroadcast' -as [type]
        if ($null -eq $type) {
            $added = Add-Type -Namespace 'Rafiki' -Name 'EnvBroadcast' -PassThru -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.IntPtr lpdwResult);
'@
            $type = @($added)[0]
        }
        $result = [System.IntPtr]::Zero
        # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5 second timeout.
        [void] $type::SendMessageTimeout([System.IntPtr] 0xffff, 0x1A, [System.IntPtr]::Zero, 'Environment', 2, 5000, [ref] $result)
    } catch {
        # Not fatal: the value is in the registry either way.
    }
}

if ($NoModifyPath) {
    Write-Step ''
    Write-Step "Add $Prefix to your PATH:"
    Write-Step "  `$env:Path = `"$Prefix;`$env:Path`""
} else {
    $pathResult = Add-ToUserPath $Prefix
    switch ($pathResult) {
        'added'   { Write-Note "Added $Prefix to your user PATH"; Publish-EnvironmentChange }
        'present' { Write-Note "$Prefix is already on your user PATH" }
        default {
            Write-Warning "Could not update your user PATH. Add $Prefix yourself:"
            Write-Step "  `$env:Path = `"$Prefix;`$env:Path`""
        }
    }
    # Make the program usable in this session too.
    if (-not (";$env:Path;".ToLowerInvariant().Contains(";$($Prefix.ToLowerInvariant());"))) {
        $env:Path = "$Prefix;$env:Path"
    }
}

# Smoke test. This is where a wrong architecture or a missing AVX2 instruction
# set shows up, so the hint about -Baseline belongs here rather than in a doc.
$ok = $false
$versionOutput = ''
$global:LASTEXITCODE = 0
try {
    $versionOutput = (& $targetPath --version 2>&1 | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0) { $ok = $true }
} catch {
    $ok = $false
}

if ($ok) {
    Write-Note "Verified: $App $("$versionOutput".Trim())"
} else {
    Write-Warning "$targetPath was installed but did not run."
    if ($arch -eq 'x64' -and $variant -eq '' -and -not $avx2Known) {
        Write-Step ''
        Write-Step 'This processor may not support AVX2. Install the baseline build:'
        Write-Step '  .\install.ps1 -Baseline'
    }
    Write-Step ''
    Write-Step 'Report the output of this command:'
    Write-Step "  & `"$targetPath`" --version"
}

Write-Step ''
Write-Step "Open a new terminal, then run $App to start."
Write-Note "The full screen interface needs Windows Terminal. The old console window (conhost) cannot draw it; in Windows 10 install Windows Terminal from the Microsoft Store, or use $App run `"your task`" instead."
