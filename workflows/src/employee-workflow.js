// Builds one dedicated, independently callable workflow per employee:
// Task Payload -> Validate Task Input -> [employee tools] -> [Build Prompt] -> AI Agent -> Post-process
// Invalid input and AI failures return an explicit { status: 'failed', error } result.
const { WorkflowBuilder } = require('../lib/n8n-builders');
const helpers = require('./employees/shared-helpers');

const SHARED = Object.values(helpers);

module.exports = function buildEmployeeWorkflow(emp) {
  const wb = new WorkflowBuilder(emp.workflow_id, `C · ${emp.employee_name}`, { executionTimeout: emp.execution_timeout || 300 });
  const codeHelpers = [`const EMPLOYEE_ID = '${emp.employee_id}';`, ...SHARED];

  wb.subworkflowTrigger('Task Payload', [0, 0]);
  wb.code('Validate Task Input', emp.validate, [220, 0], { helpers: codeHelpers });
  wb.ifTrue('Input Valid?', '={{ $json.valid }}', [440, 0]);
  wb.code('Return Validation Failure', function () {
    return failed('invalid_input', $json.errors.join(' '), false);
  }, [660, 200], { helpers: codeHelpers });
  wb.chain('Task Payload', 'Validate Task Input', 'Input Valid?');
  wb.connect('Input Valid?', 'Return Validation Failure', { output: 1 });

  // Tool steps may branch: prefetch returns its entry node and every [node, output] that must
  // continue to Build Prompt (`last` is shorthand for a single exit).
  let x = 660;
  let exits = [['Input Valid?', 0]];
  if (emp.prefetch) {
    const { first, last, lasts, width = 1 } = emp.prefetch(wb, [x, -20]);
    wb.connect('Input Valid?', first);
    exits = lasts || [[last, 0]];
    x += 220 * width;
  }
  if (emp.buildPrompt) {
    wb.code('Build Prompt', emp.buildPrompt, [x, -20], { helpers: codeHelpers });
    exits.forEach(([node, output]) => wb.connect(node, 'Build Prompt', { output }));
    exits = [['Build Prompt', 0]];
    x += 220;
  }
  const previous = exits[0][0];

  wb.aiAgent(`${emp.employee_name}`, {
    prompt: '={{ $json.prompt }}',
    systemMessage: emp.system_message,
    schema: emp.output_schema,
    temperature: emp.temperature,
  }, [x, -20]);
  wb.connect(previous, emp.employee_name);

  wb.code('Post-process Output', emp.postprocess, [x + 300, -100], { helpers: codeHelpers });
  wb.code('Return AI Failure', function () {
    const message = String(($json.error && ($json.error.message || $json.error)) || 'AI model call failed');
    return failed('ai_error', message.slice(0, 1000), true);
  }, [x + 300, 100], { helpers: codeHelpers });
  wb.connect(emp.employee_name, 'Post-process Output');
  wb.connect(emp.employee_name, 'Return AI Failure', { output: 1 });
  // Optional steps after the AI result (e.g. producing a real asset); they must end in a result node.
  if (emp.finalize) emp.finalize(wb, [x + 520, -100], 'Post-process Output', codeHelpers);
  return wb.toJSON();
};
