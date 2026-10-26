# Captures the n8n editor screens used in the presentation, from the logged-in "n8nshots" browser session.
# Usage: powershell -ExecutionPolicy Bypass -File docs/images/n8n/capture-n8n-screens.ps1 [name filter]
param([string]$Only = '')
$out = $PSScriptRoot
$shots = [ordered]@{
  '01-workflows-list'         = '/home/workflows'
  '02-architecture-map'       = '/workflow/wf0Architecture1'
  '03-ceo-planning'           = '/workflow/wfaCeoPlanning01'
  '04-dispatcher'             = '/workflow/wfbDispatcher001'
  '05-task-runner'            = '/workflow/wfbTaskRunner001'
  '06-employee-youtube'       = '/workflow/wfcEmpYtLinkdIn1'
  '07-employee-visual'        = '/workflow/wfcEmpVisualDsg1'
  '08-ceo-review'             = '/workflow/wfdCeoReview0001'
  '09-dashboard-api'          = '/workflow/wfeDashboardApi1'
  '10-linkedin-publisher'     = '/workflow/wffLinkedInPub01'
  '11-integration-check'      = '/workflow/wfgIntegrations1'
  '12-executions'             = '/home/executions'
  '13-employee-repurpose'     = '/workflow/wfcEmpRepurpose1'
  '14-employee-wecommitdw'    = '/workflow/wfcEmpSysCheck01'
  '15-employee-skill'         = '/workflow/wfcEmpSkillRec01'
  '16-employee-circle'        = '/workflow/wfcEmpCircleChk1'
  '17-employee-coaching'      = '/workflow/wfcEmpCoachTime1'
  '18-employee-knowledge'     = '/workflow/wfcEmpKnowledge1'
}
$hidePopups = (Get-Content -Raw "$PSScriptRoot\hide-n8n-popups.js").Trim()
foreach ($name in $shots.Keys) {
  if ($Only -and $name -notmatch $Only) { continue }
  agent-browser --session n8nshots eval "location.href='$($shots[$name])'" | Out-Null  # same tab keeps the login
  agent-browser --session n8nshots wait 6000 | Out-Null  # onboarding popups appear a few seconds after load
  # close any "what's new" / tour popups that would cover the canvas
  agent-browser --session n8nshots press Escape | Out-Null
  # n8n onboarding popups ("Production Checklist", "Setup evaluations") cover the canvas: hide them in the page only
  agent-browser --session n8nshots eval $hidePopups | Out-Null
  agent-browser --session n8nshots wait 500 | Out-Null
  if ((agent-browser --session n8nshots get url) -match "signin") { "STOP: signed out before $name"; break }
  agent-browser --session n8nshots screenshot "$out\$name.png" | Out-Null
  "$name done"
}
