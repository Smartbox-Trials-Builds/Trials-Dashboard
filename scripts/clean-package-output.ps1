$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$targets = @(
  (Join-Path $root 'app-release'),
  (Join-Path $root 'dist')
)

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) {
    continue
  }

  $resolved = (Resolve-Path -LiteralPath $target).Path
  if (-not $resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean outside project: $resolved"
  }

  Remove-Item -LiteralPath $resolved -Recurse -Force
}
