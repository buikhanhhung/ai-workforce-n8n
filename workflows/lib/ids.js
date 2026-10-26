// Fixed n8n ids so workflows can reference each other and employees.workflow_reference stays stable.
const WORKFLOW_IDS = {
  planning: 'wfaCeoPlanning01',
  dispatcher: 'wfbDispatcher001',
  taskRunner: 'wfbTaskRunner001',
  review: 'wfdCeoReview0001',
  dashboardApi: 'wfeDashboardApi1',
  linkedinPublisher: 'wffLinkedInPub01',
  integrationCheck: 'wfgIntegrations1',
};

const WORKFLOW_NAMES = {
  [WORKFLOW_IDS.planning]: 'A · CEO Planning',
  [WORKFLOW_IDS.dispatcher]: 'B · Task Dispatcher',
  [WORKFLOW_IDS.taskRunner]: 'B · Task Runner',
  [WORKFLOW_IDS.review]: 'D · CEO Review',
  [WORKFLOW_IDS.dashboardApi]: 'E · Dashboard API',
  [WORKFLOW_IDS.linkedinPublisher]: 'F · LinkedIn Publisher',
  [WORKFLOW_IDS.integrationCheck]: 'G · Integration Check',
};

const CREDENTIALS = {
  postgres: { id: 'wfPostgresCred01', name: 'Workforce Postgres' },
  gemini: { id: 'wfGeminiCred0001', name: 'Gemini (Workforce)' },
  apiKey: { id: 'wfApiKeyCred0001', name: 'Workforce API Key' },
  // Integrations: created empty at deploy (scripts/ensure-integration-placeholders.js) and filled
  // from the dashboard "Kết nối & tài khoản" page through the n8n public API. LinkedIn still needs
  // its OAuth "Connect" in n8n (the consent cannot be scripted).
  linkedin: { id: 'wfLinkedInCred01', name: 'LinkedIn (Workforce)', type: 'linkedInOAuth2Api',
              placeholder: { clientId: '', clientSecret: '', organizationSupport: false, legacy: false } },
  circle: { id: 'wfCircleCred0001', name: 'Circle Admin API (Workforce)', type: 'httpHeaderAuth',
            placeholder: { name: 'Authorization', value: '' } },
  wecommitdwPostgres: { id: 'wfWcdwPgCred001', name: 'WeCommitDW PostgreSQL (Workforce)', type: 'postgres',
                        placeholder: { host: '', port: 5432, database: '', user: '', password: '', ssl: 'disable' } },
  wecommitdwMysql: { id: 'wfWcdwMyCred001', name: 'WeCommitDW MySQL (Workforce)', type: 'mySql',
                     placeholder: { host: '', port: 3306, database: '', user: '', password: '', ssl: false } },
  wecommitdwMssql: { id: 'wfWcdwMsCred001', name: 'WeCommitDW SQL Server (Workforce)', type: 'microsoftSql',
                     placeholder: { server: '', port: 1433, database: '', user: '', password: '', tls: true } },
  wecommitdwApi: { id: 'wfWcdwApiCred01', name: 'WeCommitDW API (Workforce)', type: 'httpHeaderAuth',
                   placeholder: { name: 'Authorization', value: '' } },
};
// Credentials the dashboard may fill (the others are managed by scripts/import-credentials.js).
// Node credential reference: only id + name belong in workflow JSON.
const credRef = (key) => ({ id: CREDENTIALS[key].id, name: CREDENTIALS[key].name });
const INTEGRATION_CREDENTIALS = ['linkedin', 'circle', 'wecommitdwPostgres', 'wecommitdwMysql', 'wecommitdwMssql', 'wecommitdwApi'];

// Free tier: Flash allows only ~20 requests/day and Pro returns 429, so the lite models are used.
// gemini-3.5-flash-lite also reads public YouTube videos (used for real transcripts).
const GEMINI_MODEL = 'models/gemini-3.5-flash-lite';
// Used by every agent when the primary model errors (503 demand spikes, quota). Separate quota pool.
// gemini-2.5-* lite/flash are unavailable to new keys or returned empty responses through the agent.
const GEMINI_FALLBACK_MODEL = 'models/gemini-3.1-flash-lite';

// Max tasks of one plan running at the same time (keeps free-tier rate limits in check).
const MAX_RUNNING_PER_PLAN = 3;

module.exports = { WORKFLOW_IDS, WORKFLOW_NAMES, CREDENTIALS, INTEGRATION_CREDENTIALS, credRef, GEMINI_MODEL, GEMINI_FALLBACK_MODEL, MAX_RUNNING_PER_PLAN };
