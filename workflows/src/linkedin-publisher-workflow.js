// Workflow F — LinkedIn Publisher. Called by the Dashboard API only after a human approved the
// plan and asked to publish (wf.start_linkedin_publication enforces both, blocks duplicates and
// snapshots the exact package: text + image file). Posts exactly that snapshot to the member's
// personal profile — with the image when the package has one — and records the URN/URL or error.
// Local checks (image file readable) run before any LinkedIn call.
const { WorkflowBuilder } = require('../lib/n8n-builders');
const { WORKFLOW_IDS, WORKFLOW_NAMES, credRef } = require('../lib/ids');

module.exports = function buildLinkedInPublisherWorkflow() {
  const wb = new WorkflowBuilder(WORKFLOW_IDS.linkedinPublisher, WORKFLOW_NAMES[WORKFLOW_IDS.linkedinPublisher], { executionTimeout: 180 });
  const errorText = function () {
    const e = $json.error;
    const message = typeof e === 'string' ? e : (e && (e.message || e.description || JSON.stringify(e))) || 'unknown LinkedIn error';
    return [{ json: { ok: false, error: `${STEP}: ${String(message).slice(0, 1500)}` } }];
  };
  const fail = (name, step, pos) => wb.code(name, errorText, pos, { helpers: [`const STEP = '${step}';`] });
  const linkedin = { credentials: { linkedInOAuth2Api: credRef('linkedin') }, onError: 'continueErrorOutput' };
  const post = (name, withImage, pos) => wb.add(name, 'n8n-nodes-base.linkedIn', 1, {
    resource: 'post',
    operation: 'create',
    postAs: 'person',
    person: "={{ $('Get LinkedIn Member').first().json.sub }}",
    text: "={{ $('Publication Request').first().json.text }}",
    shareMediaCategory: withImage ? 'IMAGE' : 'NONE',
    ...(withImage ? { binaryPropertyName: 'data' } : {}),
    additionalFields: withImage
      ? { visibility: 'PUBLIC', title: "={{ $('Publication Request').first().json.text.split('\\n')[0].slice(0, 200) }}" }
      : { visibility: 'PUBLIC' },
  }, pos, linkedin);

  wb.subworkflowTrigger('Publication Request', [0, 0]);
  wb.ifTrue('Has Image?', "={{ !!$json.image_file }}", [220, 0]);
  wb.add('Read Image', 'n8n-nodes-base.readWriteFile', 1, {
    operation: 'read',
    fileSelector: "={{ '/data/assets/' + $('Publication Request').first().json.image_file }}",
    options: { dataPropertyName: 'data' },
  }, [440, -100], { onError: 'continueErrorOutput', alwaysOutputData: true });
  fail('Image Missing', 'image file', [660, 160]);
  // Read/Write Files returns no item (not an error) when the file does not exist.
  wb.ifTrue('Image Found?', '={{ !!($binary && $binary.data) }}', [550, -100]);
  wb.code('Image Not Found', function () {
    return [{ json: { ok: false, error: `image file: ${$('Publication Request').first().json.image_file} not found in /data/assets` } }];
  }, [660, 300]);
  // The member id (OpenID "sub") of whoever authorized the LinkedIn credential.
  wb.add('Get LinkedIn Member', 'n8n-nodes-base.httpRequest', 4.2, {
    url: 'https://api.linkedin.com/v2/userinfo',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'linkedInOAuth2Api',
    options: { timeout: 20000 },
  }, [660, 0], linkedin);
  fail('Member Lookup Failed', 'LinkedIn account', [880, 200]);
  wb.ifTrue('Post Has Image?', "={{ $('Read Image').isExecuted }}", [880, 0]);
  wb.code('Attach Image', function () {
    return [{ json: $json, binary: $('Read Image').first().binary }];
  }, [1100, -100]);
  post('Create Post With Image', true, [1320, -100]);
  post('Create Text Post', false, [1320, 100]);
  fail('Post Failed', 'LinkedIn post', [1540, 220]);
  wb.code('Published', function () {
    const r = $json || {};
    const urn = r.urn || r.id || r['x-restli-id'] || (r.headers && r.headers['x-restli-id']) || null;
    return [{ json: { ok: true, external_id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null, error: null } }];
  }, [1540, 0]);
  wb.pg('Record Publication', 'SELECT wf.finish_publication($1::uuid, $2::boolean, $3, $4, $5) AS result',
    "={{ [ $('Publication Request').first().json.publication_id, $json.ok, $json.external_id || null, $json.url || null, $json.error || null ] }}",
    [1760, 0]);

  wb.connect('Publication Request', 'Has Image?');
  wb.connect('Has Image?', 'Read Image').connect('Has Image?', 'Get LinkedIn Member', { output: 1 });
  wb.connect('Read Image', 'Image Found?').connect('Read Image', 'Image Missing', { output: 1 });
  wb.connect('Image Found?', 'Get LinkedIn Member').connect('Image Found?', 'Image Not Found', { output: 1 });
  wb.connect('Get LinkedIn Member', 'Post Has Image?').connect('Get LinkedIn Member', 'Member Lookup Failed', { output: 1 });
  wb.connect('Post Has Image?', 'Attach Image').connect('Post Has Image?', 'Create Text Post', { output: 1 });
  wb.connect('Attach Image', 'Create Post With Image');
  wb.connect('Create Post With Image', 'Published').connect('Create Post With Image', 'Post Failed', { output: 1 });
  wb.connect('Create Text Post', 'Published').connect('Create Text Post', 'Post Failed', { output: 1 });
  for (const n of ['Image Missing', 'Image Not Found', 'Member Lookup Failed', 'Post Failed', 'Published']) wb.connect(n, 'Record Publication');
  return wb.toJSON();
};
