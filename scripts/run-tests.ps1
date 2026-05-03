#!/usr/bin/env pwsh
# Run all tests: Rust integration tests + JS unit tests.

$env:PATH = "C:\Users\wit00\.cargo\bin;D:\msys64\mingw64\bin;$env:PATH"
$env:CARGO_HOME = "D:\cargo"

$root = Split-Path $PSScriptRoot -Parent

Write-Host ""
Write-Host "=== Rust Integration Tests ===" -ForegroundColor Cyan
Push-Location (Join-Path $root "src-tauri")
cargo test 2>&1
$rustResult = $LASTEXITCODE
Pop-Location

Write-Host ""
Write-Host "=== JS Unit Tests ===" -ForegroundColor Cyan
Push-Location $root
npm test 2>&1
$jsResult = $LASTEXITCODE
Pop-Location

Write-Host ""
if ($rustResult -eq 0 -and $jsResult -eq 0) {
    Write-Host "All tests passed." -ForegroundColor Green
    exit 0
} else {
    if ($rustResult -ne 0) { Write-Host "Rust tests FAILED (exit $rustResult)" -ForegroundColor Red }
    if ($jsResult -ne 0)   { Write-Host "JS tests FAILED (exit $jsResult)" -ForegroundColor Red }
    exit 1
}
