-- Integration settings tests: only non-secret keys are stored, validation, test results. Rolled back.
-- Usage: docker cp db/tests/test-integrations.sql wf-postgres:/tmp/t.sql; docker exec wf-postgres psql -U workforce -d workforce -v ON_ERROR_STOP=1 -f /tmp/t.sql
BEGIN;

DO $$
DECLARE
  v jsonb;
BEGIN
  DELETE FROM wf.integration_settings;

  -- 1. every service is listed even before anything is saved
  v := wf.api('integrations', '{}')->'data'->'services';
  ASSERT jsonb_array_length(v) = 3 AND v->0->>'service' = 'linkedin' AND v->0->'last_test' = 'null'::jsonb, format('list: %s', v);

  -- 2. a secret-looking key is rejected: secrets belong in the n8n credential
  v := wf.api('save_integration_config', '{"service":"circle","config":{"api_token":"abc"},"updated_by":"t"}');
  ASSERT (v->>'status')::int = 400 AND v->'error'->>'message' LIKE '%not allowed%', format('secret key: %s', v);
  v := wf.api('save_integration_config', '{"service":"wecommitdw","config":{"kind":"postgres","host":"h","password":"x"},"updated_by":"t"}');
  ASSERT (v->>'status')::int = 400, format('password key: %s', v);

  -- 3. validation of kind, port and URLs
  v := wf.api('save_integration_config', '{"service":"wecommitdw","config":{"kind":"oracle"},"updated_by":"t"}');
  ASSERT (v->>'status')::int = 400, 'bad kind';
  v := wf.api('save_integration_config', '{"service":"wecommitdw","config":{"kind":"postgres","port":"54x"},"updated_by":"t"}');
  ASSERT (v->>'status')::int = 400, 'bad port';
  v := wf.api('save_integration_config', '{"service":"circle","config":{"community_url":"javascript:alert(1)"},"updated_by":"t"}');
  ASSERT (v->>'status')::int = 400, 'bad url';
  v := wf.api('save_integration_config', '{"service":"nope","config":{},"updated_by":"t"}');
  ASSERT (v->>'status')::int = 400, 'unknown service';

  -- 4. save + test result; a new save clears the old test result, keeps the secret timestamp
  v := wf.api('save_integration_config', '{"service":"wecommitdw","config":{"kind":"postgres","host":"db","port":"5432","database":"dw","user":"ro","ssl":"false"},"secret_saved":true,"updated_by":"t"}');
  ASSERT (v->>'ok')::boolean AND v->'data'->'config'->>'host' = 'db' AND v->'data'->>'secret_saved_at' IS NOT NULL, format('save: %s', v);
  PERFORM wf.record_integration_test('wecommitdw', false, 'password authentication failed');
  v := wf.api('integrations', '{}')->'data'->'services'->2;
  ASSERT v->'last_test'->>'ok' = 'false' AND v->'last_test'->>'message' LIKE 'password%', format('test stored: %s', v);
  v := wf.api('save_integration_config', '{"service":"wecommitdw","config":{"kind":"postgres","host":"db2","database":"dw","user":"ro"},"updated_by":"t"}');
  ASSERT v->'data'->'last_test' = 'null'::jsonb AND v->'data'->>'secret_saved_at' IS NOT NULL, format('resave: %s', v);
  ASSERT EXISTS (SELECT 1 FROM wf.execution_events WHERE event_type = 'integration_saved'), 'save logged';

  RAISE NOTICE 'ALL INTEGRATION TESTS PASSED';
END $$;

ROLLBACK;
