// Employee 4 — Operations: analyzes supplied system data. It has no live system connection,
// so it only reports on data passed in, and checks that cited evidence really appears in it.
module.exports = {
  employee_id: 'emp_wecommitdw_checker',
  employee_name: 'WeCommitDW System Checker Agent',
  department_id: 'dept_operations',
  job_title: 'Systems Health Analyst',
  description: 'Analyzes supplied system information, logs, reports, database metadata and monitoring results to identify anomalies, risks and improvements, with evidence and severity.',
  workflow_id: 'wfcEmpSysCheck01',
  skills: [
    { skill_name: 'log_analysis', description: 'Spot errors, anomalies and patterns in logs' },
    { skill_name: 'monitoring_review', description: 'Interpret metrics, alerts and monitoring reports' },
    { skill_name: 'database_metadata_review', description: 'Review schema/size/index/job metadata for risks' },
    { skill_name: 'risk_assessment', description: 'Severity rating and prioritized recommendations' },
  ],
  input_schema: {
    type: 'object',
    'x-primary-input': 'system_data',
    'x-input-hint': 'Dán log / báo cáo / số liệu hệ thống…',
    description: 'Needs system data supplied in the request (no live system connection is configured).',
    properties: {
      system_name: { type: 'string' },
      system_data: { type: ['string', 'object'], description: 'Logs, reports, metadata or monitoring output' },
      focus: { type: 'string' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      system_name: { type: 'string' },
      data_scope: { type: 'string', description: 'What data was actually analyzed' },
      overall_health: { type: 'string', enum: ['healthy', 'degraded', 'critical', 'unknown'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            category: { type: 'string', enum: ['anomaly', 'risk', 'missing_information', 'improvement'] },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            evidence: { type: 'string', description: 'Exact quote from the supplied data' },
            recommendation: { type: 'string' },
          },
          required: ['title', 'category', 'severity', 'evidence', 'recommendation'],
        },
      },
      missing_information: { type: 'array', items: { type: 'string' } },
      improvements: { type: 'array', items: { type: 'string' } },
      unresolved_questions: { type: 'array', items: { type: 'string' } },
    },
    required: ['data_scope', 'overall_health', 'findings', 'missing_information', 'unresolved_questions'],
  },
  system_message: [
    'You are the WeCommitDW System Checker Agent in the Operations department.',
    'You analyze ONLY the system data supplied in the prompt. You have no access to any live system.',
    '- Every finding must quote its evidence verbatim from the supplied data.',
    '- Rate severity honestly; if the data is insufficient, say so in missing_information and use overall_health "unknown".',
    '- Never claim to have inspected, queried or changed a real system.',
  ].join('\n'),
  temperature: 0.2,

  validate: function () {
    const p = taskPayload();
    const data = directInput(p, ['system_data', 'logs', 'report', 'metrics', 'monitoring', 'database_metadata']);
    const deps = dependencyText(p, 20000);
    if (!data && !deps) {
      return invalid(['System data is required (input_data.system_data or context.system_data/logs/report). '
        + 'No live system connection is configured for WeCommitDW.']);
    }
    const dataText = clip(data, 80000);
    const prompt = [
      taskBrief(p),
      `System: ${textOf(directInput(p, ['system_name'])) || 'WeCommitDW'}`,
      `Focus: ${textOf(directInput(p, ['focus'])) || 'general health, anomalies and risks'}`,
      dataText ? `## Supplied system data\n${dataText}` : '',
      deps ? `## Prerequisite task outputs\n${deps}` : '',
    ].filter(Boolean).join('\n\n');
    return valid({ prompt, evidence_corpus: normalizeForMatch(`${dataText}\n${deps}`) });
  },

  postprocess: function () {
    const out = $json.output;
    const { evidence_corpus } = $('Validate Task Input').first().json;
    if (!out || !Array.isArray(out.findings)) return failed('invalid_ai_output', 'model returned no findings array', true);
    const findings = out.findings.map((f) => {
      const probe = normalizeForMatch(f.evidence).replace(/^["'`]+|["'`.]+$/g, '').slice(0, 60);
      return { ...f, evidence_verified: probe.length >= 8 && evidence_corpus.includes(probe) };
    });
    const unverified = findings.filter((f) => !f.evidence_verified).length;
    return done({
      ...out,
      findings,
      inspection_mode: 'supplied_data_only',
      integration_note: 'No live WeCommitDW connection is configured; analysis covers only the supplied data.',
    }, unverified ? [`${unverified} finding(s) cite evidence not found verbatim in the supplied data`] : []);
  },
};
