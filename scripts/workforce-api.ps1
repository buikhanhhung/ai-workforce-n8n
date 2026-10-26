# Small client for the workforce API (reads the API key from .env).
# Examples:
#   . .\scripts\workforce-api.ps1
#   Invoke-WorkforceApi GET organization
#   Invoke-WorkforceApi POST requests (Get-Content -Raw tests\requests\youtube-linkedin.json)
#   Invoke-WorkforceApi GET "plans/<plan_id>"
$script:WorkforceRoot = Split-Path -Parent $PSScriptRoot

function Invoke-WorkforceApi([string]$Method, [string]$Path, [string]$Body = $null) {
  $key = (Get-Content "$script:WorkforceRoot\.env" | Where-Object { $_ -like 'WORKFORCE_API_KEY=*' }).Split('=', 2)[1]
  $params = @{
    Uri = "http://localhost:5678/webhook/workforce/$Path"; Method = $Method; UseBasicParsing = $true
    Headers = @{ 'X-API-Key' = $key }; TimeoutSec = 300; ContentType = 'application/json; charset=utf-8'
  }
  if ($Body) { $params.Body = [System.Text.Encoding]::UTF8.GetBytes($Body) }
  try {
    $r = Invoke-WebRequest @params
    [pscustomobject]@{ status = $r.StatusCode; body = ($r.Content | ConvertFrom-Json) }
  } catch {
    $resp = $_.Exception.Response
    $text = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    $parsed = try { $text | ConvertFrom-Json } catch { $text }
    [pscustomobject]@{ status = if ($resp) { [int]$resp.StatusCode } else { 0 }; body = $parsed }
  }
}
