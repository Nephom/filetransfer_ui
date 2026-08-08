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

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Update-EnvironmentPath {
    # Freshly installed tools (git/node/rustup/...) update the Machine and/or
    # User registry PATH, but the *current* PowerShell process keeps its
    # original $env:Path until something refreshes it. Rebuild it from every
    # scope so newly installed commands are immediately discoverable in this
    # same script run, without dropping whatever the process already had.
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($machinePath, $userPath, $env:Path) |
        Where-Object { $_ } |
        ForEach-Object { $_ -split ";" } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $env:Path = ($entries | Select-Object -Unique) -join ";"
}

function Add-UserPathEntry {
    # Persist a directory onto the *User* PATH environment variable and make
    # it immediately visible to this process. Writing to the Machine scope
    # requires Administrator and is not reliably readable back in the same
    # session either way, so User scope is what actually works here: some
    # winget packages (NASM in particular) install the binary without
    # registering *any* PATH entry, Machine or User, so relying on
    # Update-EnvironmentPath picking up something the installer never wrote
    # does not help -- the directory has to be added explicitly.
    param([Parameter(Mandatory = $true)][string]$Directory)

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    if (($entries | Where-Object { $_.TrimEnd('\') -eq $Directory.TrimEnd('\') }).Count -eq 0) {
        $newUserPath = (@($entries) + $Directory) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
        Write-Host "Added '$Directory' to the User PATH environment variable."
    }
    Update-EnvironmentPath
}

function Install-WingetPackage {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [string]$Override
    )

    Require-Command "winget"
    Write-Host "Installing Windows build prerequisite: $Id"
    $wingetArgs = @(
        "install", "--id", $Id, "--exact",
        "--accept-source-agreements", "--accept-package-agreements"
    )
    if (-not [string]::IsNullOrWhiteSpace($Proxy)) { $wingetArgs += @("--proxy", $Proxy) }
    if (-not [string]::IsNullOrWhiteSpace($Override)) { $wingetArgs += @("--override", $Override) }
    Invoke-Native "winget" $wingetArgs
    Update-EnvironmentPath
}

function Test-MsvcBuildTools {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere)) { return $false }
    $installationPath = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    return -not [string]::IsNullOrWhiteSpace($installationPath)
}

function Ensure-MsvcBuildTools {
    # Rust cannot link native binaries on Windows without the MSVC linker
    # (link.exe) and Windows SDK, which only ship with Visual Studio /
    # Build Tools. This is the most common "it built on my machine but not
    # on a fresh Windows box" failure for cargo/Tauri builds.
    if (Test-MsvcBuildTools) {
        Write-Host "MSVC C++ Build Tools found."
        return
    }

    Write-Host "MSVC C++ Build Tools not found. Rust/Tauri cannot link native binaries without them."
    Write-Host "Installing Visual Studio Build Tools (C++ workload) via winget. This can take 10-20 minutes..."
    Install-WingetPackage -Id "Microsoft.VisualStudio.2022.BuildTools" `
        -Override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

    if (-not (Test-MsvcBuildTools)) {
        throw "MSVC C++ Build Tools installation did not complete. Open 'Visual Studio Installer' and add the 'Desktop development with C++' workload manually, then re-run '.\build.ps1 build'."
    }
    Write-Host "MSVC C++ Build Tools are ready."
}

function Ensure-WebView2Runtime {
    # Required to *run* the built app (Tauri renders through WebView2), not
    # strictly to build it. Ships with modern Edge/Windows 11 but can be
    # missing on Windows Server / stripped-down images, so provision it
    # best-effort and never fail the build over it.
    $webview2Keys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    if (Get-ItemProperty -Path $webview2Keys -ErrorAction SilentlyContinue) {
        Write-Host "Microsoft Edge WebView2 Runtime found."
        return
    }
    if (-not (Get-Command "winget" -ErrorAction SilentlyContinue)) { return }

    Write-Host "Microsoft Edge WebView2 Runtime not detected. Installing (required to run the built app)..."
    try {
        Install-WingetPackage -Id "Microsoft.EdgeWebView2Runtime"
    }
    catch {
        Write-Warning "Could not install Microsoft Edge WebView2 Runtime automatically. Install it manually before running the built app: https://developer.microsoft.com/microsoft-edge/webview2/"
    }
}

function Ensure-RustToolchain {
    if (-not (Get-Command "rustup" -ErrorAction SilentlyContinue)) {
        Write-Host "rustup not found on PATH; assuming an existing Rust toolchain is already configured."
        return
    }
    Invoke-Native "rustup" @("default", "stable-x86_64-pc-windows-msvc")
    Invoke-Native "rustup" @("target", "add", "x86_64-pc-windows-msvc")
}

function Find-NasmExecutable {
    # winget's NASM.NASM package has been observed to install the binary
    # without registering *any* PATH entry (Machine or User), so
    # Get-Command/Update-EnvironmentPath alone cannot find it afterward.
    # Search the locations the official NASM installer and winget's
    # per-user package store actually use.
    $candidates = @(
        (Join-Path $env:ProgramFiles "NASM\nasm.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "NASM\nasm.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }

    $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path -LiteralPath $wingetPackages) {
        $found = Get-ChildItem -LiteralPath $wingetPackages -Filter "nasm.exe" -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }

    return $null
}

function Ensure-Nasm {
    # `russh` (the SSH backend) defaults to the `aws-lc-rs` crypto backend,
    # whose `aws-lc-sys` build script compiles hand-written x86_64 assembly
    # for its optimized primitives on Windows using NASM specifically (not
    # the MSVC assembler `ml64.exe` that ships with the C++ Build Tools).
    # Without it, `cargo check`/`cargo build` fails with "NASM command not
    # found" the moment `aws-lc-sys` builds, even though every other native
    # dependency links fine.
    if (Get-Command "nasm" -ErrorAction SilentlyContinue) {
        Write-Host "NASM found."
        return
    }

    Write-Host "NASM not found. The aws-lc-sys crate (a russh SSH dependency) requires it to build its assembly-optimized crypto routines on Windows."
    Install-WingetPackage -Id "NASM.NASM"

    if (-not (Get-Command "nasm" -ErrorAction SilentlyContinue)) {
        # The winget install may have succeeded without adding NASM to
        # PATH at all. Locate the installed binary ourselves and add its
        # folder to the *User* PATH environment variable (this is the
        # scope that actually persists and takes effect here -- see
        # Add-UserPathEntry).
        $nasmExe = Find-NasmExecutable
        if ($nasmExe) {
            Write-Host "Found NASM at '$nasmExe' but it was not registered on PATH by its installer; adding it now."
            Add-UserPathEntry -Directory (Split-Path -Parent $nasmExe)
        }
    }

    if (-not (Get-Command "nasm" -ErrorAction SilentlyContinue)) {
        throw "NASM installation did not complete. Install it manually from https://www.nasm.us/, add its install folder to your User PATH environment variable (System Properties > Environment Variables > User variables > Path), open a new PowerShell window, then re-run '.\build.ps1 build'."
    }
    Write-Host "NASM is ready."
}

function Ensure-WindowsBuildTools {
    Update-EnvironmentPath

    if (-not (Test-IsAdministrator)) {
        Write-Warning "Not running as Administrator. If Visual Studio Build Tools or WebView2 Runtime need to be installed, re-run this script from an elevated PowerShell session (Run as Administrator) if winget reports permission errors."
    }

    if (-not (Get-Command "git" -ErrorAction SilentlyContinue)) {
        Install-WingetPackage -Id "Git.Git"
    }
    if (-not (Get-Command "node" -ErrorAction SilentlyContinue) -or -not (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)) {
        Install-WingetPackage -Id "OpenJS.NodeJS.LTS"
    }
    if (-not (Get-Command "cargo" -ErrorAction SilentlyContinue) -or -not (Get-Command "rustc" -ErrorAction SilentlyContinue)) {
        Install-WingetPackage -Id "Rustlang.Rustup"
    }
    Ensure-Nasm

    Ensure-RustToolchain
    Ensure-MsvcBuildTools
    Ensure-WebView2Runtime

    Update-EnvironmentPath
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

function Get-AppVersionInfo {
    # Mirrors build.sh's application_version()/application_version_display():
    # derive the release-metadata version (VERSION + RELEASE_DATE + current
    # commit) once via scripts/version.js, so the Windows desktop build gets
    # the exact same "VERSION-commit (RELEASE_DATE)" identity as the WebUI
    # and the Linux/Mac Tauri build instead of drifting from whatever was
    # last hand-typed into fileapi_ui's own package.json/Cargo.toml/tauri.conf.json.
    $json = node (Join-Path $Root "scripts\version.js") | Out-String
    return $json | ConvertFrom-Json
}

function Build-Desktop {
    Write-Host "Building nFterm v$(Get-AppVersion) for Windows..."
    Install-DesktopDependencies
    $versionInfo = Get-AppVersionInfo
    Write-Host "Desktop build identity: $($versionInfo.display)"
    $env:VITE_APP_VERSION = $versionInfo.version
    $env:VITE_APP_VERSION_DISPLAY = $versionInfo.display
    Invoke-Native "npm.cmd" @("run", "build", "--prefix", $DesktopRoot)
    Push-Location (Join-Path $DesktopRoot "src-tauri")
    try { Invoke-Native "cargo" @("check", "--locked") }
    finally { Pop-Location }

    Invoke-Native "npm.cmd" @("run", "tauri", "build", "--prefix", $DesktopRoot, "--", "--bundles", "nsis", "--config", "{`"version`":`"$($versionInfo.version)`"}")

    # Report whatever Tauri actually produced instead of guessing the
    # installer filename (it embeds the app version, which can differ from
    # the repo-level VERSION file and would otherwise go stale silently).
    $releaseDir = Join-Path $DesktopRoot "src-tauri\target\release"
    $exePath = Join-Path $releaseDir "nFterm.exe"
    if (Test-Path -LiteralPath $exePath) {
        Write-Host "Portable EXE: $exePath"
    }
    else {
        Write-Warning "Expected EXE not found at $exePath"
    }

    $nsisDir = Join-Path $releaseDir "bundle\nsis"
    $installer = Get-ChildItem -LiteralPath $nsisDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($installer) {
        Write-Host "NSIS package: $($installer.FullName)"
    }
    else {
        Write-Warning "NSIS installer not found under $nsisDir"
    }
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

build    Check/install Windows build tools (Git, Node.js, Rust, MSVC C++
         Build Tools, WebView2 Runtime) and build the desktop Tauri package.
upgrade  Fast-forward the checkout and update desktop dependencies.
self-upgrade Update this PowerShell build script from the tracked upstream branch.

This script is for the build machine. It may use winget to install missing
build tools (some, like Visual Studio Build Tools, may require an elevated
/ Administrator PowerShell session). End users only receive the generated
portable EXE / NSIS installer.
"@
}

Set-ProxyEnvironment
switch ($Command) {
    "build" { Build-Desktop }
    "upgrade" { Upgrade-Checkout }
    "self-upgrade" { Self-UpgradeScript }
    default { Show-Help }
}
