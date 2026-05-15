param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $false)][string]$ShortcutName = 'DesktopLLMOverlay.lnk'
)

try {
    $ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
} catch {
    Write-Error "Project folder not found: $ProjectRoot"
    exit 1
}

$scriptPath = Join-Path $ProjectRoot 'others\scripts\start-background.js'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    Write-Error "Missing script: $scriptPath"
    exit 1
}

# cmd.exe + PATH: reliable at login (avoid embedding Cursor/other Node paths).
$cmdArgs = '/c cd /d "' + $ProjectRoot + '" && node "' + $scriptPath + '"'

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup $ShortcutName

$cmdExe = $env:COMSPEC
if (-not $cmdExe -or -not (Test-Path -LiteralPath $cmdExe)) {
    $cmdExe = "$env:SystemRoot\System32\cmd.exe"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $cmdExe
$shortcut.Arguments = $cmdArgs
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Desktop LLM overlay - runs start:bg at login'
$shortcut.Save()

Write-Host ""
Write-Host "Startup shortcut created:"
Write-Host "  $lnkPath"
Write-Host ""
Write-Host "README and scripts are NOT copied here - they stay in:"
Write-Host "  $ProjectRoot"
Write-Host ""
