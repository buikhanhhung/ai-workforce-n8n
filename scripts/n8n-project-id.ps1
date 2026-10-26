# Prints the n8n owner's personal project id, needed by deploy-workforce.ps1 and import-credentials.js.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/n8n-project-id.ps1
$ErrorActionPreference = 'Stop'
docker cp "$PSScriptRoot\n8n-project-id.js" n8n:/tmp/n8n-project-id.js | Out-Null
try { docker exec n8n node /tmp/n8n-project-id.js; $code = $LASTEXITCODE }
finally { docker exec -u root n8n rm -f /tmp/n8n-project-id.js | Out-Null }
exit $code
