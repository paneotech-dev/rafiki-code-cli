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

# Why a gate failed is said three times: in the log, in the job's step summary
# ($env:GITHUB_STEP_SUMMARY), and as a workflow annotation (::error) for each
# failing facet and for a gate that could not start. The annotation is the one
# that can be read without the log.
$GateName = "release gate $Target (installer)"
function Write-Annotation([string] $Level, [string] $Title, [string] $Message) {
    if ($env:GITHUB_ACTIONS -ne 'true') { return }
    $data = $Message.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    $name = $Title.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A').Replace(':', '%3A').Replace(',', '%2C')
    Write-Host "::$Level title=$name::$data"
}
function Add-Summary([string] $Line) {
    if ([string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) { return }
    try { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $Line -Encoding utf8 } catch { }
}

function Stop-Gate([string] $Message) {
    [Console]::Error.WriteLine("release gate: $Message")
    Write-Annotation 'error' "${GateName}: not run" $Message
    Add-Summary "### ${GateName}: not run"
    Add-Summary ''
    Add-Summary $Message
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
    Write-Annotation 'error' "${GateName}: not run" 'RAFIKICODE_STAGING_API_KEY is not set, so the gate cannot sign in or run a task against staging. The release is blocked until the repository secret is added.'
    Add-Summary "### ${GateName}: not run"
    Add-Summary ''
    Add-Summary 'RAFIKICODE_STAGING_API_KEY is not set, so the gate cannot sign in or run a task against staging.'
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
$reasons = New-Object System.Collections.Generic.List[string]
$failed = 0
$skipped = 0
Add-Summary "### $GateName, $Version, on this machine"
Add-Summary ''
Add-Summary '| facet | verdict | detail |'
Add-Summary '| --- | --- | --- |'
function Get-Clean([string] $Text) {
    $clean = ($Text -replace "[`r`n`t]+", ' ').Trim()
    if ($key -ne '') { $clean = $clean.Replace($key, '[staging credential]') }
    if ($clean.Length -gt 400) { $clean = $clean.Substring(0, 400) }
    return $clean
}
function Write-Verdict([string] $Facet, [string] $Verdict, [string] $Detail) {
    $clean = Get-Clean $Detail
    $script:rows.Add("$Target`tinstaller`t$Facet`t$Verdict`t$clean")
    Write-Host ("  {0,-8} {1,-5} {2}" -f $Facet, $Verdict, $clean)
    Add-Summary "| $Facet | $Verdict | $($clean.Replace('|', '\|')) |"
}
function Add-Verdict([string] $Facet, [bool] $Ok, [string] $Detail) {
    if (-not $Ok) {
        $script:failed++
        $clean = Get-Clean $Detail
        $script:reasons.Add("${Facet}: $clean")
        # One annotation per failing facet: the reason, readable without the
        # log. A facet that only repeats "nothing was installed" adds none.
        if ($clean -ne 'nothing was installed') { Write-Annotation 'error' "${GateName}: $Facet failed" $clean }
    }
    Write-Verdict $Facet $(if ($Ok) { 'pass' } else { 'fail' }) $Detail
}
# Something worth telling that is not a verdict: a warning annotation.
function Add-Note([string] $Facet, [string] $Text) {
    $clean = Get-Clean $Text
    Write-Host "  note     ${Facet}: $clean"
    Write-Annotation 'warning' "${GateName}: $Facet note" $clean
    $script:notes.Add("Note, ${Facet}: $clean")
}
$notes = New-Object System.Collections.Generic.List[string]
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
    # The installer's output is shown as it comes and kept, so that a failed
    # install is reported with the installer's own error line.
    $installLog = Join-Path $work 'install.log'
    # What it writes to standard error is text here, not a PowerShell error:
    # the preference is relaxed for this one call so that a line on standard
    # error cannot end the gate before the verdict.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & powershell.exe @installArgs 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $installLog
        $installStatus = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    $bin = Join-Path $profileDir '.rafikicode\bin\rafikicode.exe'
    $installed = ($installStatus -eq 0) -and (Test-Path -LiteralPath $bin)
    $installSaid = @()
    if (Test-Path -LiteralPath $installLog) { $installSaid = @(Get-Content -LiteralPath $installLog | Where-Object { "$_".Trim() -ne '' }) }
    $installReason = @($installSaid | Where-Object { "$_" -match '^\s*(Error|ERROR)\b' -or "$_" -match 'Installed, but not ready' } | Select-Object -First 1)
    if ($installReason.Count -eq 0) { $installReason = @($installSaid | Select-Object -Last 1) }
    $installWhy = if ($installReason.Count -gt 0) { "$($installReason[0])".Replace($profileDir, '~') } else { 'it printed nothing' }
    Add-Verdict 'install' $installed $(if ($installed) { $bin } else { "install.ps1 exited $installStatus and ~\.rafikicode\bin\rafikicode.exe is $(if (Test-Path -LiteralPath $bin) { 'present' } else { 'missing' }): $installWhy" })
    $notReady = @($installSaid | Where-Object { "$_" -match 'Installed, but not ready' } | Select-Object -First 1)
    if ($installed -and $notReady.Count -gt 0) { Add-Note 'install' "$($notReady[0])" }

    if (-not $installed) {
        foreach ($facet in @('version', 'licence', 'signin', 'task')) { Add-Verdict $facet $false 'nothing was installed' }
    } else {
        # Standard output is the answer and must be the version alone, on one
        # line: installers, update checks and scripts compare it. Standard
        # error is kept apart and reported as a note, so a line the binary says
        # about this machine neither passes for the version nor hides it.
        $versionErr = Join-Path $work 'version.err.txt'
        $versionStatus = -1
        $printed = @()
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $printed = @(& $bin --version 2>$versionErr | ForEach-Object { "$_" } | Where-Object { $_.Trim() -ne '' })
            $versionStatus = $LASTEXITCODE
        } catch {
            Add-Content -LiteralPath $versionErr -Value "$_"
        } finally { $ErrorActionPreference = $previousPreference }
        $said = @()
        if (Test-Path -LiteralPath $versionErr) { $said = @(Get-Content -LiteralPath $versionErr | Where-Object { "$_".Trim() -ne '' }) }
        $got = if ($printed.Count -gt 0) { "$($printed[0])".Trim() } else { '' }
        if ($said.Count -gt 0) { Add-Note 'version' "--version wrote to standard error: $(($said | Select-Object -First 3) -join ' ')" }
        if ($versionStatus -eq 0 -and $got -eq $Version -and $printed.Count -eq 1) {
            Add-Verdict 'version' $true $got
        } elseif ($versionStatus -eq 0 -and $got -eq $Version) {
            Add-Verdict 'version' $false "standard output has $($printed.Count) lines where the version alone belongs: $($printed[1])"
        } else {
            $tail = if ($said.Count -gt 0) { "; standard error: $($said[0])" } else { '' }
            Add-Verdict 'version' $false "exit $versionStatus, printed '$got' on standard output, releasing $Version$tail"
        }

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

Add-Summary ''
foreach ($line in $notes) { Add-Summary $line }
if ($failed -ne 0) {
    Write-Host "release gate: $Target FAILED ($failed of $($Facets.Count) facets). This build blocks the release."
    foreach ($reason in $reasons) { Write-Host "release gate: reason: $reason" }
    Add-Summary ''
    Add-Summary "**FAILED: $failed of $($Facets.Count) facets. This build blocks the release.**"
    Add-Summary ''
    foreach ($reason in $reasons) { Add-Summary "- $reason" }
    exit 1
}
if ($skipped -ne 0) {
    Write-Host "release gate: $Target passed $($Facets.Count - $skipped) of $($Facets.Count) facets; signin and task were $SkippedVerdict."
    Add-Summary "Passed $($Facets.Count - $skipped) of $($Facets.Count) facets; signin and task were $SkippedVerdict."
    exit 0
}
Write-Host "release gate: $Target passed all $($Facets.Count) facets."
Add-Summary "Passed all $($Facets.Count) facets."
exit 0
