-- External integrations entered from the dashboard (LinkedIn, Circle, WeCommitDW).
-- Secrets live ONLY in n8n's encrypted credential store; this table keeps the non-secret part
-- (what to show and what workflows need, e.g. the WeCommitDW connection kind) and the last test.
-- Idempotent; applied after library.sql.

CREATE TABLE IF NOT EXISTS wf.integration_settings (
  service         text PRIMARY KEY CHECK (service IN ('linkedin', 'circle', 'wecommitdw')),
  config          jsonb NOT NULL DEFAULT '{}',
  secret_saved_at timestamptz,            -- when a secret was last written to the n8n credential
  updated_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_test       jsonb                   -- { ok, message, at } from the connection test workflow
);

-- Allowed non-secret keys per service: anything else (e.g. a password typed in the wrong field) is rejected.
CREATE OR REPLACE FUNCTION wf.integration_config_keys(p_service text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_service
    WHEN 'linkedin' THEN ARRAY['client_id_hint']
    WHEN 'circle' THEN ARRAY['community_url']
    WHEN 'wecommitdw' THEN ARRAY['kind', 'host', 'port', 'database', 'user', 'ssl', 'base_url', 'health_path']
  END;
$$;

CREATE OR REPLACE FUNCTION wf.api_integrations() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('services', jsonb_agg(jsonb_build_object(
    'service', s.service, 'config', coalesce(i.config, '{}'), 'secret_saved_at', i.secret_saved_at,
    'updated_by', i.updated_by, 'updated_at', i.updated_at, 'last_test', i.last_test) ORDER BY s.ord))
  FROM (VALUES ('linkedin', 1), ('circle', 2), ('wecommitdw', 3)) s(service, ord)
  LEFT JOIN wf.integration_settings i USING (service);
$$;

CREATE OR REPLACE FUNCTION wf.save_integration_config(p_service text, p_config jsonb, p_secret_saved boolean, p_by text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[] := wf.integration_config_keys(p_service);
  v_config jsonb := coalesce(p_config, '{}');
  v_bad text[];
  v_kind text;
  v_url text;
BEGIN
  IF v_allowed IS NULL THEN
    RAISE EXCEPTION 'unknown service %', p_service USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(v_config) <> 'object' THEN
    RAISE EXCEPTION 'config must be an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(trim(p_by), '') = '' THEN
    RAISE EXCEPTION 'updated_by is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT array_agg(k) INTO v_bad FROM jsonb_object_keys(v_config) k WHERE NOT k = ANY (v_allowed);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'config keys not allowed for %: % (secrets belong in the n8n credential)', p_service, v_bad
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_kind := v_config->>'kind';
  IF p_service = 'wecommitdw' AND coalesce(v_kind, '') NOT IN ('postgres', 'mysql', 'mssql', 'http') THEN
    RAISE EXCEPTION 'kind must be postgres, mysql, mssql or http' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_config ? 'port' AND (v_config->>'port') !~ '^[0-9]{1,5}$' THEN
    RAISE EXCEPTION 'port must be a number' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOREACH v_url IN ARRAY ARRAY[v_config->>'community_url', v_config->>'base_url'] LOOP
    IF coalesce(v_url, '') <> '' AND v_url !~ '^https?://[^\s/]+' THEN
      RAISE EXCEPTION 'URL must start with http:// or https://' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;
  INSERT INTO wf.integration_settings (service, config, secret_saved_at, updated_by, updated_at, last_test)
  VALUES (p_service, v_config, CASE WHEN p_secret_saved THEN now() END, trim(p_by), now(), NULL)
  ON CONFLICT (service) DO UPDATE SET
    config = EXCLUDED.config,
    secret_saved_at = CASE WHEN p_secret_saved THEN now() ELSE wf.integration_settings.secret_saved_at END,
    updated_by = EXCLUDED.updated_by, updated_at = now(),
    last_test = NULL;                        -- the old test result no longer describes this configuration
  PERFORM wf.log_event(NULL, NULL, 'integration_saved',
                       jsonb_build_object('service', p_service, 'secret_saved', p_secret_saved, 'by', trim(p_by)));
  RETURN (SELECT x FROM jsonb_array_elements(wf.api_integrations()->'services') x WHERE x->>'service' = p_service);
END $$;

CREATE OR REPLACE FUNCTION wf.record_integration_test(p_service text, p_ok boolean, p_message text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v jsonb := jsonb_build_object('ok', coalesce(p_ok, false), 'message', left(coalesce(p_message, ''), 1000), 'at', now());
BEGIN
  IF wf.integration_config_keys(p_service) IS NULL THEN
    RAISE EXCEPTION 'unknown service %', p_service USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO wf.integration_settings (service, last_test) VALUES (p_service, v)
  ON CONFLICT (service) DO UPDATE SET last_test = v;
  RETURN v || jsonb_build_object('service', p_service);
END $$;
