// Small helpers to build n8n workflow JSON deterministically (stable node ids across rebuilds).
const crypto = require('crypto');
const { CREDENTIALS, GEMINI_MODEL, GEMINI_FALLBACK_MODEL, WORKFLOW_NAMES } = require('./ids');

const stableUuid = (seed) => {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// Turns a function into Code-node source: the function body runs as the Code node script.
// Helpers (other functions) are prepended so several employees can share them without copy-paste.
const codeFrom = (fn, helpers = []) => {
  const src = fn.toString();
  const body = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}'));
  const helperSrc = helpers.map((h) => h.toString()).join('\n\n');
  return `${helperSrc ? helperSrc + '\n\n' : ''}${body.replace(/^\n/, '')}`.trim() + '\n';
};

class WorkflowBuilder {
  constructor(id, name, settings = {}) {
    this.id = id;
    this.name = name;
    this.nodes = [];
    this.connections = {};
    this.settings = { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner', ...settings };
  }

  add(name, type, typeVersion, parameters, position, extra = {}) {
    if (this.nodes.some((n) => n.name === name)) throw new Error(`duplicate node name "${name}" in ${this.name}`);
    this.nodes.push({ id: stableUuid(`${this.id}:${name}`), name, type, typeVersion, position, parameters, ...extra });
    return name;
  }

  connect(from, to, { output = 0, input = 0, type = 'main' } = {}) {
    const byType = (this.connections[from] ||= {});
    const outputs = (byType[type] ||= []);
    while (outputs.length <= output) outputs.push([]);
    outputs[output].push({ node: to, type, index: input });
    return this;
  }

  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i], names[i + 1]);
    return this;
  }

  // ── node shortcuts ──

  code(name, fn, position, { helpers = [], ...extra } = {}) {
    return this.add(name, 'n8n-nodes-base.code', 2, { jsCode: codeFrom(fn, helpers) }, position, extra);
  }

  // Parameterised SQL ($1, $2 …). params is an n8n expression returning an array.
  pg(name, query, params, position, extra = {}) {
    // one query + transaction per item, so one failing item cannot affect the others
    const parameters = { operation: 'executeQuery', query, options: { queryBatching: 'independently' } };
    if (params) parameters.options.queryReplacement = params;
    return this.add(name, 'n8n-nodes-base.postgres', 2.6, parameters, position, {
      credentials: { postgres: CREDENTIALS.postgres },
      ...extra,
    });
  }

  // Calls another workflow by id. wait=false gives fire-and-forget (true concurrency).
  // targetName: display name of the target workflow (enables the editor's "open sub-workflow" link).
  callWorkflow(name, workflowId, position, { wait = true, mode = 'once', targetName, ...extra } = {}) {
    const isExpr = String(workflowId).startsWith('=');
    const ref = isExpr
      ? { __rl: true, mode: 'id', value: workflowId }
      : { __rl: true, mode: 'list', value: workflowId, cachedResultName: targetName || WORKFLOW_NAMES[workflowId] || workflowId,
          cachedResultUrl: `/workflow/${workflowId}` };
    return this.add(name, 'n8n-nodes-base.executeWorkflow', 1.2, {
      source: 'database',
      workflowId: ref,
      workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [],
                        attemptToConvertTypes: false, convertFieldsToString: true },
      mode,
      options: { waitForSubWorkflow: wait },
    }, position, extra);
  }

  subworkflowTrigger(name, position) {
    return this.add(name, 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' }, position);
  }

  webhook(name, method, path, position) {
    return this.add(name, 'n8n-nodes-base.webhook', 2.1, {
      httpMethod: method, path, authentication: 'headerAuth', responseMode: 'responseNode', options: {},
    }, position, { webhookId: stableUuid(`webhook:${method}:${path}`), credentials: { httpHeaderAuth: CREDENTIALS.apiKey } });
  }

  // Responds with the {status_code, body} produced by the previous node.
  respond(name, position) {
    return this.add(name, 'n8n-nodes-base.respondToWebhook', 1.5, {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify($json.body) }}',
      options: { responseCode: '={{ $json.status_code }}' },
    }, position);
  }

  ifTrue(name, expression, position) {
    return this.add(name, 'n8n-nodes-base.if', 2.2, {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: stableUuid(`${this.id}:${name}:cond`), leftValue: expression, rightValue: '',
                       operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    }, position);
  }

  // AI Agent + Gemini model (+ fallback model) + Structured Output Parser, wired together.
  aiAgent(name, { prompt, systemMessage, schema, temperature = 0.3, maxOutputTokens = 8192 }, position) {
    const [x, y] = position;
    this.add(name, '@n8n/n8n-nodes-langchain.agent', 3.1, {
      promptType: 'define', text: prompt, hasOutputParser: true, needsFallback: true,
      options: { systemMessage, maxIterations: 4, enableStreaming: false },
    }, position, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' });
    const model = this.add(`${name} Model`, '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1.2, {
      modelName: GEMINI_MODEL, options: { temperature, maxOutputTokens },
    }, [x - 160, y + 220], { credentials: { googlePalmApi: CREDENTIALS.gemini } });
    const fallback = this.add(`${name} Fallback Model`, '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1.2, {
      modelName: GEMINI_FALLBACK_MODEL, options: { temperature, maxOutputTokens },
    }, [x, y + 220], { credentials: { googlePalmApi: CREDENTIALS.gemini } });
    const parser = this.add(`${name} Output Parser`, '@n8n/n8n-nodes-langchain.outputParserStructured', 1.3, {
      schemaType: 'manual', inputSchema: JSON.stringify(schema, null, 2),
    }, [x + 160, y + 220]);
    this.connect(model, name, { type: 'ai_languageModel' });
    this.connect(fallback, name, { type: 'ai_languageModel', input: 1 });
    this.connect(parser, name, { type: 'ai_outputParser' });
    return name;
  }

  toJSON() {
    return {
      id: this.id, name: this.name, nodes: this.nodes, connections: this.connections,
      settings: this.settings, active: false, pinData: {}, meta: { templateCredsSetupCompleted: true },
    };
  }
}

module.exports = { WorkflowBuilder, codeFrom, stableUuid };
