# Explicit, temporary loopback-only automatic login. No existing process is stopped.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
# Check IPv4 and IPv6 HTTP/OPC listeners before any backend initialization.
& node (Join-Path $PSScriptRoot 'check-local-ports.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Local startup cancelled. Free the listed ports in their owning terminals first.' }
$env:STRICT_LOCAL_PORT = 'true'
$env:NODE_ENV = 'development'
$env:LOCAL_AUTO_LOGIN = 'true'
$env:LOCAL_AUTO_LOGIN_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173'
$env:PORT = '3000'
Write-Host 'Metallurgist auto-login enabled for this backend process.'
Write-Host 'Open http://127.0.0.1:5173. Use Ctrl+C here to stop the backend.'
Push-Location (Join-Path $projectRoot 'MetalliSense_Backend_Simple')
try { node server.js } finally { Pop-Location }
