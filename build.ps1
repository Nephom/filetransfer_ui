param(
    [ValidateSet("build", "upgrade", "self-upgrade", "help")]
    [string]$Command = "help",
    [switch]$Interactive,
    [string]$Proxy
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$DesktopRoot = Join-Path $Root "fileapi_ui"

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [string[]]$Arguments = @()
    )

    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $File $($Arguments -join ' ')"
    }
}

function Require-Command {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found. Install it or ask your administrator to provide it."
    }
}

function Install-WingetPackage {
    param([Parameter(Mandatory = $true)][string]$Id)

    Require-Command "winget"
    Write-Host "Installing Windows build prerequisite: $Id"
    Invoke-Native "winget" @(
        "install", "--id", $Id, "--exact",
        "--accept-source-agreements", "--accept-package-agreements"
    )
}

function Ensure-WindowsBuildTools {
    if (-not (Get-Command "git" -ErrorAction SilentlyContinue)) {
        Install-WingetPackage "Git.Git"
    }
    if (-not (Get-Command "node" -ErrorAction SilentlyContinue) -or -not (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)) {
        Install-WingetPackage "OpenJS.NodeJS.LTS"
    }
    if (-not (Get-Command "cargo" -ErrorAction SilentlyContinue) -or -not (Get-Command "rustc" -ErrorAction SilentlyContinue)) {
        Install-WingetPackage "Rustlang.Rustup"
    }

    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($machinePath -and $userPath) { $env:Path = "$machinePath;$userPath" }
    Write-Host "Windows build prerequisites are ready."
}

function Set-ProxyEnvironment {
    if ([string]::IsNullOrWhiteSpace($Proxy)) { return }
    if ($Proxy -notmatch '^https?://[^/:]+(:[0-9]+)?/?$') {
        throw "Proxy must use http://host:port or https://host:port."
    }

    $env:http_proxy = $Proxy
    $env:https_proxy = $Proxy
    $env:HTTP_PROXY = $Proxy
    $env:HTTPS_PROXY = $Proxy
    $env:npm_config_proxy = $Proxy
    $env:npm_config_https_proxy = $Proxy
    $env:CARGO_HTTP_PROXY = $Proxy
}

function Install-DesktopDependencies {
    Ensure-WindowsBuildTools
    Require-Command "node"
    Require-Command "npm.cmd"
    Require-Command "cargo"
    Require-Command "rustc"

    Write-Host "Using Node: $(node --version)"
    Write-Host "Using Rust: $(rustc --version)"
    Write-Host "Installing desktop dependencies..."
    Invoke-Native "npm.cmd" @("ci", "--ignore-scripts", "--include=optional", "--prefix", $DesktopRoot)
    Invoke-Native "npm.cmd" @("rebuild", "--foreground-scripts", "--prefix", $DesktopRoot)
}

function Get-AppVersion {
    return (Get-Content -LiteralPath (Join-Path $Root "VERSION") -Raw).Trim()
}

function Build-Desktop {
    Install-DesktopDependencies
    Invoke-Native "npm.cmd" @("run", "build", "--prefix", $DesktopRoot)
    Push-Location (Join-Path $DesktopRoot "src-tauri")
    try { Invoke-Native "cargo" @("check", "--locked") }
    finally { Pop-Location }

    Invoke-Native "npm.cmd" @("run", "tauri", "build", "--prefix", $DesktopRoot, "--", "--bundles", "nsis")
    Write-Host "Portable EXE: $DesktopRoot\src-tauri\target\release\fileapi-desktop.exe"
    Write-Host "NSIS package: $DesktopRoot\src-tauri\target\release\bundle\nsis\File Transfer Desktop_$(Get-AppVersion)_x64-setup.exe"
}

function Upgrade-Checkout {
    Require-Command "git"
    $status = @(git -C $Root status --porcelain --untracked-files=all)
    if ($status.Count -gt 0) {
        throw "Refusing to upgrade a working tree with uncommitted changes. Keep .env and src/config.ini ignored, but commit or stash tracked changes first."
    }

    Invoke-Native "git" @("-C", $Root, "fetch", "origin")
    $upstream = (git -C $Root rev-parse --abbrev-ref '@{u}').Trim()
    if ([string]::IsNullOrWhiteSpace($upstream)) { throw "Unable to determine the upstream branch." }
    $versionRef = $upstream + ":VERSION"
    $targetVersion = (git -C $Root show $versionRef 2>$null).Trim()
    Write-Host "Upstream application version: $targetVersion"
    Invoke-Native "git" @("-C", $Root, "merge", "--ff-only", $upstream)

    $upgradeTool = Join-Path $Root "upgrade_tools\config-upgrade.js"
    if (Test-Path -LiteralPath (Join-Path $Root "src\config.ini")) {
        $upgradeArgs = @($upgradeTool, "--target-version", $targetVersion)
        if (-not $Interactive) { $upgradeArgs += "--non-interactive" }
        Invoke-Native "node" $upgradeArgs
    }
    Install-DesktopDependencies
    Write-Host "Upgrade complete. The server install/setup lifecycle remains available through build.sh."
}

function Test-PowerShellSyntax {
    param([Parameter(Mandatory = $true)][string]$Path)

    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
        throw "PowerShell syntax validation failed for $Path`: $($errors -join '; ')"
    }
}

function Self-UpgradeScript {
    Require-Command "git"
    $upstream = (git -C $Root rev-parse --abbrev-ref '@{u}').Trim()
    if ([string]::IsNullOrWhiteSpace($upstream)) { throw "Unable to determine the upstream branch." }
    Invoke-Native "git" @("-C", $Root, "fetch", "origin")

    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("filetransfer-build-{0}.ps1" -f [Guid]::NewGuid())
    try {
        $scriptRef = $upstream + ":build.ps1"
        git -C $Root show $scriptRef | Set-Content -LiteralPath $temporary -Encoding UTF8
        if ($LASTEXITCODE -ne 0) { throw "Unable to read build.ps1 from $upstream." }
        Test-PowerShellSyntax $temporary
        Copy-Item -LiteralPath $temporary -Destination (Join-Path $Root "build.ps1") -Force
        Write-Host "build.ps1 updated from $upstream."
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Show-Help {
    @"
Usage: .\build.ps1 <build|upgrade|self-upgrade|help> [-Interactive] [-Proxy URL]

build    Check Windows build tools and build the desktop Tauri package.
upgrade  Fast-forward the checkout and update desktop dependencies.
self-upgrade Update this PowerShell build script from the tracked upstream branch.

This script is for the build machine. It may use winget to install missing
build tools. End users only receive the generated portable EXE.
"@
}

Set-ProxyEnvironment
switch ($Command) {
    "build" { Build-Desktop }
    "upgrade" { Upgrade-Checkout }
    "self-upgrade" { Self-UpgradeScript }
    default { Show-Help }
}
