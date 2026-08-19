$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeBin = 'C:\Users\Jorda\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
if (Test-Path -LiteralPath $nodeBin) {
  $env:Path = "$nodeBin;$env:Path"
}

$stage = Join-Path $root '.electron-package'
$output = Join-Path $root 'app-release'
$electronDist = Join-Path $root 'node_modules\electron\dist'
$electronPackageJson = Join-Path $root 'node_modules\electron\package.json'
$vite = Join-Path $root 'node_modules\vite\bin\vite.js'
$esbuildPackage = Get-ChildItem -LiteralPath (Join-Path $root 'node_modules\.pnpm') -Directory | Where-Object { $_.Name -like 'esbuild@*' } | Select-Object -First 1
$esbuild = if ($esbuildPackage) { Join-Path $esbuildPackage.FullName 'node_modules\esbuild\bin\esbuild' } else { Join-Path $root 'node_modules\.bin\esbuild.cmd' }
$electronBuilder = Join-Path $root 'node_modules\.bin\electron-builder.cmd'
$updateUrl = if ($env:TRIALS_UPDATE_URL) { $env:TRIALS_UPDATE_URL } else { 'https://example.com/trials-dashboard-updates' }
$githubOwner = if ($env:TRIALS_GITHUB_OWNER) { $env:TRIALS_GITHUB_OWNER } else { 'Smartbox-Trials-Builds' }
$githubRepo = if ($env:TRIALS_GITHUB_REPO) { $env:TRIALS_GITHUB_REPO } else { 'Trials-Dashboard' }
$publishConfig = if ($githubOwner -and $githubRepo) {
  @{
    provider = 'github'
    owner = $githubOwner
    repo = $githubRepo
    releaseType = 'release'
  }
} else {
  @{
    provider = 'generic'
    url = $updateUrl
  }
}

if (-not (Test-Path -LiteralPath $vite)) {
  throw "Vite is not installed. Run pnpm install first."
}

if (-not (Test-Path -LiteralPath $electronBuilder)) {
  throw "Electron Builder is not installed. Run pnpm install first."
}

if (-not (Test-Path -LiteralPath $esbuild)) {
  throw "esbuild is not installed. Run pnpm install first."
}

if (-not (Test-Path -LiteralPath (Join-Path $electronDist 'electron.exe'))) {
  throw "Electron runtime is not installed. Run pnpm rebuild electron, then retry."
}

$electronVersion = ((Get-Content -Raw -LiteralPath $electronPackageJson) | ConvertFrom-Json).version

foreach ($target in @($stage, $output)) {
  if (-not (Test-Path -LiteralPath $target)) {
    continue
  }

  $resolved = (Resolve-Path -LiteralPath $target).Path
  if (-not $resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove outside project: $resolved"
  }

  Remove-Item -LiteralPath $resolved -Recurse -Force
}

& node $vite build --base=./
if ($LASTEXITCODE -ne 0) {
  throw "Vite build failed."
}

New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination (Join-Path $stage 'dist') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'electron') -Destination (Join-Path $stage 'electron') -Recurse
Set-Content -LiteralPath (Join-Path $stage 'pnpm-workspace.yaml') -Value "packages: []`n" -Encoding ASCII

$mainEntry = Join-Path $root 'electron\main.js'
$mainBundle = Join-Path $stage 'electron\main.cjs'
& node $esbuild $mainEntry --bundle --platform=node --format=cjs --external:electron "--outfile=$mainBundle"
if ($LASTEXITCODE -ne 0) {
  throw "Electron main bundle failed."
}

$shimDir = Join-Path $stage '.bin'
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
@'
@echo off
echo {"dependencies":{}}
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $shimDir 'npm.cmd') -Encoding ASCII

$stagePackage = @{
  name = 'trials-operations-dashboard'
  version = '1.0.0'
  description = 'Windows desktop trials operations dashboard backed by Supabase Realtime.'
  main = 'electron/main.cjs'
  dependencies = @{}
  devDependencies = @{}
  build = @{
    appId = 'com.trials.operations.dashboard'
    productName = 'Trials Operations Dashboard'
    electronVersion = $electronVersion
    electronDist = $electronDist
    npmRebuild = $false
    nodeGypRebuild = $false
    buildDependenciesFromSource = $false
    publish = @($publishConfig)
    win = @{
      target = @(
        'nsis',
        'portable'
      )
    }
    nsis = @{
      oneClick = $false
      perMachine = $false
      allowToChangeInstallationDirectory = $true
      createDesktopShortcut = $true
      createStartMenuShortcut = $true
      shortcutName = 'Trials Operations Dashboard'
    }
    files = @(
      'dist/**/*',
      'electron/**/*',
      'package.json'
    )
    directories = @{
      output = $output
    }
  }
}

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $stage 'package.json'), ($stagePackage | ConvertTo-Json -Depth 8), $utf8NoBom)

Push-Location $stage
try {
  $env:Path = "$shimDir;$env:Path"
  & $electronBuilder --win nsis portable --publish never
  if ($LASTEXITCODE -ne 0) {
    throw "Electron Builder failed."
  }
}
finally {
  Pop-Location
}
