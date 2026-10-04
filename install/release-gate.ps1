<#
.SYNOPSIS
    The release gate for one Windows build. Counterpart of install/release-gate.sh.

.DESCRIPTION
    Serves the archives a release is about to publish from a loopback mirror,
    installs one of them with install.ps1 into an empty profile directory, and
    checks five things: the install, --version, the licence files, a sign-in
    with the staging test credential, and one hello world task against
    staging. Any facet that is not a pass fails the gate.

    The staging test credential is read from RAFIKICODE_STAGING_API_KEY. Without
    it the gate stops with exit code 2 before doing anything, unless -NoLive
    is given.

    This script has not been run on Windows. It was written against
    install.ps1 and release-gate.sh and is exercised for the first time by the
    release workflow.

.PARAMETER Target
    windows-x64, windows-x64-baseline or windows-arm64.

.PARAMETER Version
    The version being released, without the leading v.

.PARAMETER Assets
    Directory holding the release archives and SHA256SUMS.

.PARAMETER Results
    Optional path of a TSV file: target, channel, facet, verdict, detail.

.PARAMETER NoLive
    A pre-release without the staging key. The two facets that call staging,
    signin and task, are not run and are recorded as "skipped (no staging key,
    pre-release)", never as a pass; install, version and licence run as
    always. Refused for a version without a pre-release part and when
    RAFIKICODE_STAGING_API_KEY is set. The release workflow passes it only
    when the secret is not configured for a pre-release; a missing key without
    it still stops the gate.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Target,
    [Parameter(Mandatory = $true)] [string] $Version,
    [Parameter(Mandatory = $true)] [string] $Assets,
    [string] $Results,
    [int] $Port = 4170,
    [int] $TaskTimeoutSeconds = 180,
    [switch] $NoLive
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Facets = @('install', 'version', 'licence', 'signin', 'task')
$SkippedVerdict = 'skipped (no staging key, pre-release)'
$Version = $Version -replace '^v', ''

function Stop-Gate([string] $Message) {
    [Console]::Error.WriteLine("release gate: $Message")
    exit 2
}

if ($Target -notin @('windows-x64', 'windows-x64-baseline', 'windows-arm64')) {
    Stop-Gate "$Target is not a Windows build this product publishes"
}
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
    Stop-Gate '-Version must be the version being released, for example 0.2.0'
}

# Fail closed, before anything else is done, and name the secret.
$key = [Environment]::GetEnvironmentVariable('RAFIKICODE_STAGING_API_KEY')
if ($NoLive) {
    # Skipping the live facets is asked for, never inferred from an empty key.
    if ($Version -notmatch '-') {
        Stop-Gate "-NoLive is for a pre-release only, and $Version has no pre-release part: a release is gated against staging"
    }
    if (-not [string]::IsNullOrWhiteSpace($key)) {
        Stop-Gate '-NoLive was given while RAFIKICODE_STAGING_API_KEY is set: drop -NoLive to run the live facets, or unset the key'
    }
    $key = ''
    [Console]::Error.WriteLine('release gate: -NoLive, a pre-release without the staging key: signin and task are skipped, every other facet runs.')
} elseif ([string]::IsNullOrWhiteSpace($key)) {
    [Console]::Error.WriteLine('release gate: RAFIKICODE_STAGING_API_KEY is not set.')
    [Console]::Error.WriteLine('  The gate signs in with a staging test account and runs one task against')
    [Console]::Error.WriteLine('  staging. Without that credential it cannot say the build works, so it')
    [Console]::Error.WriteLine('  does not run and the release is blocked. Add the repository secret')
    [Console]::Error.WriteLine('  RAFIKICODE_STAGING_API_KEY.')
    exit 2
}

$archive = "rafikicode-$Target.zip"
$archivePath = Join-Path $Assets $archive
$sumsPath = Join-Path $Assets 'SHA256SUMS'
if (-not (Test-Path -LiteralPath $sumsPath)) { Stop-Gate "no SHA256SUMS in $Assets" }
if (-not (Test-Path -LiteralPath $archivePath)) { Stop-Gate "no $archive in ${Assets}: the build for $Target was not produced" }

# What is gated is what is published: the archive must be the one SHA256SUMS names.
$expected = ''
foreach ($line in Get-Content -LiteralPath $sumsPath) {
    $parts = $line.Trim() -split '\s+', 2
    if ($parts.Count -eq 2 -and ($parts[1] -replace '^\*', '') -eq $archive) { $expected = $parts[0].ToLowerInvariant() }
}
if ($expected -eq '') { Stop-Gate "SHA256SUMS has no entry for $archive" }
$actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { Stop-Gate "$archive does not match SHA256SUMS (expected $expected, got $actual)" }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("rafikicode-gate-" + [Guid]::NewGuid().ToString('N'))
$site = Join-Path $work 'site'
$download = Join-Path $site "dl\download\v$Version"
New-Item -ItemType Directory -Path (Join-Path $site 'api\releases') -Force | Out-Null
New-Item -ItemType Directory -Path $download -Force | Out-Null
Set-Content -LiteralPath (Join-Path $site 'api\releases\latest') -Value "{`"tag_name`": `"v$Version`", `"name`": `"v$Version`"}" -Encoding ascii
Copy-Item -LiteralPath $sumsPath -Destination (Join-Path $download 'SHA256SUMS')
Copy-Item -LiteralPath $archivePath -Destination (Join-Path $download $archive)

$rows = New-Object System.Collections.Generic.List[string]
$failed = 0
$skipped = 0
function Write-Verdict([string] $Facet, [string] $Verdict, [string] $Detail) {
    $clean = $Detail -replace "[`r`n`t]+", ' '
    if ($key -ne '') { $clean = $clean.Replace($key, '[staging credential]') }
    $script:rows.Add("$Target`tinstaller`t$Facet`t$Verdict`t$clean")
    Write-Host ("  {0,-8} {1,-5} {2}" -f $Facet, $Verdict, $clean)
}
function Add-Verdict([string] $Facet, [bool] $Ok, [string] $Detail) {
    if (-not $Ok) { $script:failed++ }
    Write-Verdict $Facet $(if ($Ok) { 'pass' } else { 'fail' }) $Detail
}
function Add-Skipped([string] $Facet, [string] $Detail) {
    $script:skipped++
    Write-Verdict $Facet $SkippedVerdict $Detail
}

# The mirror: python's static file server on loopback, GitHub's layout.
$server = Start-Process -FilePath 'python' -ArgumentList @('-m', 'http.server', "$Port", '--bind', '127.0.0.1') `
    -WorkingDirectory $site -PassThru -WindowStyle Hidden
$mirror = "http://127.0.0.1:$Port"

try {
    $up = $false
    for ($i = 0; $i -lt 60 -and -not $up; $i++) {
        try { Invoke-WebRequest -UseBasicParsing -Uri "$mirror/dl/download/v$Version/SHA256SUMS" -TimeoutSec 5 | Out-Null; $up = $true }
        catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $up) { Stop-Gate "the local release mirror did not come up on port $Port" }

    # An empty profile directory, so the install starts from nothing whatever
    # the runner image came with. -NoModifyPath: the user PATH in the registry
    # belongs to the runner, and the gate calls the binary by its full path.
    $profileDir = Join-Path $work 'home'
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    $env:USERPROFILE = $profileDir
    $env:HOME = $profileDir
    $env:RAFIKICODE_RELEASE_API = "$mirror/api"
    $env:RAFIKICODE_RELEASE_BASE = "$mirror/dl"
    $env:RAFIKICODE_DISABLE_AUTOUPDATE = '1'
    Remove-Item Env:RAFIKICODE_API_KEY -ErrorAction SilentlyContinue

    Write-Host "release gate: $Target $Version via installer (this machine)"
    $installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'install.ps1'), '-NoModifyPath')
    if ($Target -like '*-baseline') { $installArgs += '-Baseline' }
    & powershell.exe @installArgs
    $installStatus = $LASTEXITCODE
    $bin = Join-Path $profileDir '.rafikicode\bin\rafikicode.exe'
    $installed = ($installStatus -eq 0) -and (Test-Path -LiteralPath $bin)
    Add-Verdict 'install' $installed $(if ($installed) { $bin } else { "install.ps1 exited $installStatus" })

    if (-not $installed) {
        foreach ($facet in @('version', 'licence', 'signin', 'task')) { Add-Verdict $facet $false 'nothing was installed' }
    } else {
        $got = ''
        try { $got = "$(& $bin --version 2>&1 | Select-Object -First 1)".Trim() } catch { $got = "$_" }
        Add-Verdict 'version' ($LASTEXITCODE -eq 0 -and $got -eq $Version) "printed '$got', releasing $Version"

        $licenceText = ''
        try { $licenceText = (& $bin licenses 2>&1 | Out-String) } catch { $licenceText = '' }
        $licenceDir = Join-Path $profileDir '.rafikicode\licenses'
        $licenceOk = ($licenceText -match 'Permission is hereby granted') `
            -and (Test-Path -LiteralPath (Join-Path $licenceDir 'LICENSE')) `
            -and (Test-Path -LiteralPath (Join-Path $licenceDir 'NOTICE'))
        Add-Verdict 'licence' $licenceOk $(if ($licenceOk) { "printed by the binary, and LICENSE and NOTICE are in $licenceDir" } else { 'the licence text or the licence files are missing' })
    }

    if ($installed -and $NoLive) {
        Add-Skipped 'signin' 'whoami against staging was not run'
        Add-Skipped 'task' 'no task was sent to staging'
    } elseif ($installed) {
        $env:RAFIKICODE_API_KEY = $key
        $gateway = [Environment]::GetEnvironmentVariable('RAFIKICODE_STAGING_GATEWAY_URL')
        $console = [Environment]::GetEnvironmentVariable('RAFIKICODE_STAGING_CONSOLE_URL')
        if (-not [string]::IsNullOrWhiteSpace($gateway)) { $env:RAFIKICODE_GATEWAY_URL = $gateway }
        if (-not [string]::IsNullOrWhiteSpace($console)) { $env:RAFIKICODE_CONSOLE_URL = $console }

        $who = ''
        try { $who = (& $bin whoami 2>&1 | Out-String) } catch { $who = "$_" }
        $whoStatus = $LASTEXITCODE
        $account = ($who -split "`n" | Where-Object { $_ -match '^Account:' } | Select-Object -First 1)
        $signedIn = ($whoStatus -eq 0) -and ($who -notmatch 'Could not load the account') -and (-not [string]::IsNullOrWhiteSpace($account))
        Add-Verdict 'signin' $signedIn $(if ($signedIn) { "$account" } else { "whoami exited ${whoStatus}: $(($who -split "`n" | Select-Object -Last 2) -join ' ')" })

        $taskDir = Join-Path $work 'task'
        New-Item -ItemType Directory -Path $taskDir -Force | Out-Null
        $outFile = Join-Path $taskDir 'out.txt'
        $errFile = Join-Path $taskDir 'err.txt'
        $emptyInput = Join-Path $taskDir 'empty.txt'
        Set-Content -LiteralPath $emptyInput -Value '' -NoNewline
        $prompt = 'Reply with exactly these two words and nothing else: hello world'
        $task = Start-Process -FilePath $bin -ArgumentList @('run', "`"$prompt`"") -WorkingDirectory $taskDir `
            -RedirectStandardInput $emptyInput -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
            -PassThru -WindowStyle Hidden
        $finished = $task.WaitForExit($TaskTimeoutSeconds * 1000)
        if (-not $finished) { try { $task.Kill() } catch { } }
        $answer = if (Test-Path -LiteralPath $outFile) { Get-Content -LiteralPath $outFile -Raw } else { '' }
        $taskOk = $finished -and ($task.ExitCode -eq 0) -and ("$answer" -match 'hello world')
        Add-Verdict 'task' $taskOk $(if ($taskOk) { "answered with 'hello world'" } elseif (-not $finished) { "no answer within $TaskTimeoutSeconds seconds" } else { "exit $($task.ExitCode): $(("$answer" -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1))" })
    }
} finally {
    if ($server -and -not $server.HasExited) { try { $server.Kill() } catch { } }
    if (-not [string]::IsNullOrWhiteSpace($Results)) { Set-Content -LiteralPath $Results -Value $rows -Encoding utf8 }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failed -ne 0) {
    Write-Host "release gate: $Target FAILED ($failed of $($Facets.Count) facets). This build blocks the release."
    exit 1
}
if ($skipped -ne 0) {
    Write-Host "release gate: $Target passed $($Facets.Count - $skipped) of $($Facets.Count) facets; signin and task were $SkippedVerdict."
    exit 0
}
Write-Host "release gate: $Target passed all $($Facets.Count) facets."
exit 0
