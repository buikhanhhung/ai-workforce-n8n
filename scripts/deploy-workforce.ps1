# Deploys the AI workforce system to the local Docker stack:
# schema + organization seed -> build workflows -> import -> publish -> restart n8n.
# Core credentials are imported separately (scripts/import-credentials.js) and are not touched here;
# empty integration credentials are created only when missing (filled later from the dashboard).
param(
  [Parameter(Mandatory = $true)][string]$ProjectId   # n8n project that owns the workflows
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Copies the file into the container instead of piping: Windows PowerShell 5.1 pipes to native
# commands in ASCII, which turns Vietnamese text into '?'.
function Invoke-Psql([string]$file) {
  docker cp $file wf-postgres:/tmp/deploy.sql
  docker exec wf-postgres psql -U workforce -d workforce -v ON_ERROR_STOP=1 -q -f /tmp/deploy.sql
  $code = $LASTEXITCODE
  docker exec wf-postgres rm -f /tmp/deploy.sql
  if ($code -ne 0) { throw "psql failed for $file" }
}

Write-Host '1/5 Building workflows and seed'
node "$root\workflows\build-workflows.js"
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

Write-Host '2/5 Applying schema and organization seed'
Invoke-Psql "$root\db\schema.sql"
Invoke-Psql "$root\db\planning.sql"
Invoke-Psql "$root\db\queue.sql"
Invoke-Psql "$root\db\dashboard-functions.sql"
Invoke-Psql "$root\db\publishing.sql"
Invoke-Psql "$root\db\library.sql"
Invoke-Psql "$root\db\integrations.sql"
Invoke-Psql "$root\db\generated\seed-organization.sql"

Write-Host '3/5 Importing workflows (and empty integration credentials when missing)'
node "$root\scripts\ensure-integration-placeholders.js" $ProjectId
if ($LASTEXITCODE -ne 0) { throw 'integration credential placeholders failed' }
docker exec -u root n8n sh -c 'rm -rf /tmp/wfimport && mkdir -p /tmp/wfimport'
docker cp "$root\workflows\dist\." n8n:/tmp/wfimport/
docker exec -u root n8n chown -R node /tmp/wfimport
docker exec n8n n8n import:workflow --separate --input=/tmp/wfimport --projectId=$ProjectId
if ($LASTEXITCODE -ne 0) { throw 'import failed' }

Write-Host '4/5 Publishing workflows'
# wf0* workflows are maps without triggers: imported, never published
Get-ChildItem "$root\workflows\dist\*.json" | Where-Object { $_.BaseName -notlike 'wf0*' } | ForEach-Object {
  # retried because the CLI can hit a transient SQLite lock while n8n is running
  for ($try = 1; $try -le 3; $try++) {
    docker exec n8n n8n publish:workflow --id=$($_.BaseName) | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    if ($try -eq 3) { throw "publish failed for $($_.BaseName)" }
    Start-Sleep 2
  }
}
docker exec -u root n8n rm -rf /tmp/wfimport

Write-Host '5/5 Restarting n8n'
docker restart n8n | Out-Null
for ($i = 0; $i -lt 60; $i++) {
  try { if ((Invoke-WebRequest -UseBasicParsing http://localhost:5678/healthz/readiness -TimeoutSec 2).StatusCode -eq 200) { break } } catch {}
  Start-Sleep 2
}
Write-Host 'Done: n8n is ready at http://localhost:5678'
