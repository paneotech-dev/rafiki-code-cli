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
    Ask for the x64 archive labelled "baseline" instead of letting this script
    choose. This is not a fix for a program that will not start: every published
    baseline archive is byte identical to the sibling it sits beside, so it
    installs the same bytes under another name. It is here so a release can be
    verified against the asset it names.

.PARAMETER NoModifyPath
    Do not change the user PATH; print the directory to add instead.

.PARAMETER DryRun
    Resolve the version and report what would happen. Download nothing.

.EXAMPLE
    irm https://github.com/paneotech-dev/rafiki-code-cli/releases/latest/download/install.ps1 | iex

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

# The documented install is `irm ... | iex`, which runs this text inside the
# user's own PowerShell session. There an `exit` ends that session and closes
# the window before anyone can read why, and strict mode, the error preference
# and every helper function would stay behind in it. So the whole installer
# runs in the script block below, left unindented so the here-string in it
# keeps its closing marker in the first column: a failure is printed and ends
# the block, and only the handler at the end decides how to stop. Run as a
# file (.\install.ps1, pwsh -File) it exits with code 1; run through iex it
# returns to the prompt with $LASTEXITCODE set to 1 and the window open.
try {
& {
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

function Write-Step([string] $Message) { Write-Host $Message }
function Write-Note([string] $Message) { Write-Host $Message -ForegroundColor DarkGray }
function Fail([string] $Message) {
    Write-Host "Error: $Message" -ForegroundColor Red
    # Ends the installer through the handler at the end of this file, after
    # the finally block that removes the scratch directory has run.
    throw 'rafikicode-install-failed'
}

if ([string]::IsNullOrWhiteSpace($Version)) { $Version = Get-EnvOrDefault 'VERSION' '' }
if ([string]::IsNullOrWhiteSpace($Prefix)) { $Prefix = Get-EnvOrDefault 'RAFIKICODE_INSTALL_DIR' '' }
if ([string]::IsNullOrWhiteSpace($Prefix)) {
    # Windows always sets USERPROFILE. Without it this is not Windows, or not a
    # normal session, and there is no default place to install to.
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        Fail "USERPROFILE is not set, so there is no default install directory. This installer is for Windows. On macOS or Linux run: curl -fsSL https://get.rafikiai.io | bash . To install here anyway, name the directory with -Prefix or RAFIKICODE_INSTALL_DIR."
    }
    $Prefix = Join-Path (Join-Path $env:USERPROFILE '.rafikicode') 'bin'
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
# available on PowerShell 7 and later, where System.Runtime.Intrinsics exists;
# on Windows PowerShell 5.1 the normal build is chosen.
#
# This selection is kept, but it currently changes nothing, and it must not be
# offered to anyone as a remedy. Two things were measured against the published
# 0.1.7 assets. All four archives labelled baseline are byte identical to the
# siblings they exist to replace, because the build toolchain serves one runtime
# per operating system, architecture and C library and returns the same runtime
# for a baseline target, so asking for the baseline build downloads the same
# file. And the ordinary binary needs no AVX2: it was driven under emulation on
# a 2008 Nehalem, which has neither AVX nor AVX2, where --version, --help and
# doctor all exited 0, including a live gateway call. So there is no CPU this
# switch is known to rescue and no different bytes for it to fetch.
#
# It stays because the asset names are real and published, the branch resolves
# and installs a working binary, the duplication is upstream rather than ours,
# and the day upstream builds the two variants differently this is already
# correct with nothing further to do. script/platform-coverage.ts hashes every
# binary and names any targets that collide, so the day that changes is visible.
$variant = ''
if ($Baseline) {
    $variant = 'baseline'
} elseif ($arch -eq 'x64') {
    try {
        $avx2Type = [Type]::GetType('System.Runtime.Intrinsics.X86.Avx2')
        if ($null -ne $avx2Type -and -not $avx2Type::IsSupported) { $variant = 'baseline' }
    } catch {
        # No way to ask on this runtime. The ordinary build needs no AVX2, so
        # there is nothing to fall back to.
    }
}

$target = "windows-$arch"
if ($variant -ne '') { $target = "$target-$variant" }
$asset = "$App-$target.zip"

# Version resolution.
if ([string]::IsNullOrWhiteSpace($Version)) {
    $latestUrl = "$ReleaseApi/releases/latest"
    $resolved = ''
    $apiError = ''
    try {
        $release = Invoke-RestMethod -Uri $latestUrl -Headers @{
            'Accept'     = 'application/vnd.github+json'
            'User-Agent' = $App
        } -UseBasicParsing
        if ($release.tag_name) { $resolved = "$($release.tag_name)" -replace '^v', '' }
    } catch {
        $apiError = $_.Exception.Message
    }
    if ($resolved -eq '') {
        # The API allows 60 requests an hour per IP address, shared by everyone
        # behind that address, and answers 403 once they are used. The release
        # page is not rate limited and redirects to the newest tag, so read the
        # version from where it points. WebRequest rather than
        # Invoke-WebRequest because stopping at a redirect is spelled
        # differently, and fails differently, on Windows PowerShell 5.1 and
        # PowerShell 7; this is the same on both.
        try {
            $pageRequest = [System.Net.WebRequest]::Create("$ReleaseBase/latest")
            $pageRequest.AllowAutoRedirect = $false
            $pageRequest.UserAgent = $App
            $pageResponse = $pageRequest.GetResponse()
            $location = "$($pageResponse.Headers['Location'])"
            $pageResponse.Close()
            if ($location -match '/tag/v?([^/]+)$') { $resolved = $Matches[1] }
        } catch {
            # Reported below, together with what the API said.
        }
    }
    if ($resolved -eq '') {
        if ($apiError -eq '') { Fail "The latest release at $latestUrl has no tag name." }
        $hint = ''
        if ($apiError -match '403|rate limit') {
            $hint = " A 403 here usually means the GitHub API's hourly allowance for your IP address is used up, which an office network or a shared CI runner can do. Name the version to skip the API: pick one from $ReleaseBase and pass -Version."
        }
        Fail "Could not read the latest version from $latestUrl : $apiError$hint"
    }
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
    return
}

# Already installed at this version.
if (Test-Path -LiteralPath $targetPath) {
    $installed = ''
    try { $installed = (& $targetPath --version 2>$null | Select-Object -First 1) } catch { $installed = '' }
    if ("$installed".Trim() -eq $resolved) {
        Write-Note "Version $resolved is already installed at $targetPath"
        Write-Note "Next: $App login, then $App doctor to check the setup."
        return
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

    # The licence and the notice travel with the binary. The archive carries
    # both beside it; they are kept in the product's own directory. An archive
    # from before they were packed has neither, and that is not an error: the
    # binary prints the same text with `rafikicode licenses`.
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $licenceDir = Join-Path (Join-Path $env:USERPROFILE ".$App") 'licenses'
        foreach ($name in @('LICENSE', 'NOTICE')) {
            $licenceFile = Join-Path $extract $name
            if (Test-Path -LiteralPath $licenceFile) {
                try {
                    New-Item -ItemType Directory -Path $licenceDir -Force | Out-Null
                    Copy-Item -LiteralPath $licenceFile -Destination (Join-Path $licenceDir $name) -Force
                } catch { }
            }
        }
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

# Smoke test. This is where a build that cannot run on this machine shows up.
# It does not suggest -Baseline: that archive is the same bytes, as recorded at
# the variant selection above, so a reinstall would cost the user a download and
# change nothing. An installed binary that will not run is a bug in the build.
# The whole output is collected before the exit code is read: a pipeline into
# Select-Object -First 1 stops reading early and leaves LASTEXITCODE at 0, so a
# program that printed a line and then failed counted as working. Standard
# error is dropped with the preference relaxed, because Windows PowerShell 5.1
# turns any line on it into a terminating error under 'Stop'.
$ok = $false
$versionOutput = ''
$global:LASTEXITCODE = 0
$savedPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $targetPath --version 2>$null)
    if ($LASTEXITCODE -eq 0 -and $output.Count -gt 0) {
        $ok = $true
        $versionOutput = "$($output[0])"
    }
} catch {
    $ok = $false
} finally {
    $ErrorActionPreference = $savedPreference
}

if ($ok) {
    Write-Note "Verified: $App $("$versionOutput".Trim())"
} else {
    # Exit 1, so a script or CI job that runs this installer sees the failure.
    Write-Step ''
    Write-Step 'Installing a different build will not help: this is a bug worth reporting.'
    Write-Step 'Report the output of both of these, including which processor this is:'
    Write-Step "  & `"$targetPath`" --version"
    Write-Step '  Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name'
    Fail "$targetPath was installed but did not run ($App --version failed). The installation is not usable."
}

# A folder to start in. Started from the home folder, rafikicode works in
# %USERPROFILE%\RafikiCode instead (a home folder is not a project, and walking
# all of it before the first request is what made a first run hang), so the
# folder is made here and the next steps start there. rafikicode makes it on
# first use as well, so failing here is not an error.
$workspace = ''
if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    try {
        $workspace = Join-Path $env:USERPROFILE 'RafikiCode'
        New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    } catch {
        $workspace = ''
    }
}

Write-Step ''
Write-Step 'Next steps, in a new terminal (this one does not have the new PATH yet):'
Write-Step '  1. Sign in to your Rafiki AI account:'
Write-Step "       $App login"
Write-Step '  2. Check the whole setup, once signed in:'
Write-Step "       $App doctor"
Write-Step '  3. Start it in your workspace folder, or in any project folder:'
if ($workspace -ne '') { Write-Step '       cd $HOME\RafikiCode' }
Write-Step "       $App"
Write-Note "The full screen interface needs Windows Terminal. The old console window (conhost) cannot draw it; in Windows 10 install Windows Terminal from the Microsoft Store (or: winget install --id Microsoft.WindowsTerminal), or use $App run `"your task`" instead."
}
} catch {
    if ("$($_.Exception.Message)" -ne 'rafikicode-install-failed') {
        Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    }
    # Run as a file, this file's own text is the invocation's script block, and
    # the marker below is in it. Through iex the invocation is the caller's
    # (the prompt line, or the caller's script), which does not carry it.
    $asFile = $false
    try { $asFile = "$($MyInvocation.MyCommand.ScriptBlock)".Contains('RAFIKICODE-INSTALL-PS1-AS-FILE') } catch { }
    if ($asFile) { exit 1 }
    Remove-Variable -Name asFile -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 1
}
