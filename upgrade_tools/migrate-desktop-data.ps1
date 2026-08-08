<#
.SYNOPSIS
    One-time migration for existing nFterm (formerly "File Transfer
    Desktop" / fileapi-desktop) users: copies the legacy local data
    directory to the new location so undo history and operation logs
    survive the rebrand.

.DESCRIPTION
    Prior to the nFterm rename, the desktop app stored its undo history
    (undo-history.json) and operation log (operations.log) under:

        %USERPROFILE%\.fileapi-desktop

    New builds look for that data under:

        %USERPROFILE%\.nFterm

    This script copies the legacy directory's contents into the new one.
    It is safe to run multiple times: it never deletes the legacy
    directory, and it will not overwrite a ".nFterm" directory that
    already has content unless -Force is passed.

.PARAMETER Force
    Overwrite files already present under the new ".nFterm" directory.

.EXAMPLE
    .\migrate-desktop-data.ps1
#>
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$legacyDir = Join-Path $env:USERPROFILE ".fileapi-desktop"
$newDir = Join-Path $env:USERPROFILE ".nFterm"

if (-not (Test-Path -LiteralPath $legacyDir)) {
    Write-Host "No legacy data directory found at '$legacyDir'. Nothing to migrate."
    exit 0
}

if (-not (Test-Path -LiteralPath $newDir)) {
    New-Item -ItemType Directory -Path $newDir -Force | Out-Null
    Write-Host "Created '$newDir'."
}

$existingFiles = Get-ChildItem -LiteralPath $newDir -File -ErrorAction SilentlyContinue
if ($existingFiles.Count -gt 0 -and -not $Force) {
    Write-Warning "'$newDir' already has content. Re-run with -Force to overwrite it with the legacy data, or migrate manually."
    exit 1
}

Copy-Item -LiteralPath (Join-Path $legacyDir "*") -Destination $newDir -Recurse -Force:$Force -ErrorAction Stop
Write-Host "Migrated undo history and operation logs from '$legacyDir' to '$newDir'."
Write-Host "The legacy directory was left in place; delete it manually once you've confirmed nFterm works as expected."
