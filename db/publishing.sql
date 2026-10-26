-- External publishing (LinkedIn). A post is published only for a plan a human approved
-- (status completed), at most once per plan and channel. Idempotent; applied after schema.sql.

CREATE TABLE IF NOT EXISTS wf.publications (
  publication_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id        uuid NOT NULL REFERENCES wf.plans ON DELETE CASCADE,
  task_id        text NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('linkedin')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
  content        text NOT NULL,
  external_id    text,
  url            text,
  error          text,
  requested_by   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  FOREIGN KEY (plan_id, task_id) REFERENCES wf.tasks ON DELETE CASCADE
);
-- Image attached to the post: a file name under the shared assets directory (snapshotted at publish time).
ALTER TABLE wf.publications ADD COLUMN IF NOT EXISTS image_file text;

-- Duplicate-publish guard: one pending or published post per plan and channel.
CREATE UNIQUE INDEX IF NOT EXISTS publications_one_live_idx
  ON wf.publications (plan_id, channel) WHERE status IN ('pending', 'published');

-- LinkedIn renders plain text: strip Markdown emphasis/headings so "**bold**" never appears literally.
CREATE OR REPLACE FUNCTION wf.linkedin_plain_text(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
           '\*\*([^*\n]+)\*\*', '\1', 'g'),
           '__([^_\n]+)__', '\1', 'g'),
           '^#{1,6}[ \t]+', '', 'gn'),
           '^[ \t]*\*[ \t]+', '• ', 'gn');
$$;

-- The post package of a plan: the latest LinkedIn text (YouTube-to-LinkedIn post, else a Repurpose
-- linkedin_post asset) plus the latest rendered image of the same plan (Visual Design), if any.
CREATE OR REPLACE FUNCTION wf.find_linkedin_post(p_plan uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT x || coalesce((
    SELECT jsonb_build_object('image_url', o.output->'asset_urls'->>0, 'image_task_id', o.task_id,
                              'image_file', regexp_replace(o.output->'asset_urls'->>0, '^/assets/', ''))
    FROM wf.task_outputs o JOIN wf.tasks t USING (plan_id, task_id)
    WHERE o.plan_id = p_plan AND t.assigned_employee_id = 'emp_visual_design'
      AND (o.output->>'image_generated')::boolean AND o.output->'asset_urls'->>0 LIKE '/assets/%'
    ORDER BY o.created_at DESC LIMIT 1), '{}'::jsonb)
  FROM (
    SELECT jsonb_build_object('task_id', o.task_id, 'text', wf.linkedin_plain_text(o.output->>'post'), 'created_at', o.created_at) AS x, o.created_at, 1 AS pref
    FROM wf.task_outputs o JOIN wf.tasks t USING (plan_id, task_id)
    WHERE o.plan_id = p_plan AND t.assigned_employee_id = 'emp_yt_linkedin' AND coalesce(o.output->>'post', '') <> ''
    UNION ALL
    SELECT jsonb_build_object('task_id', o.task_id, 'text', wf.linkedin_plain_text(a->>'content'), 'created_at', o.created_at), o.created_at, 2
    FROM wf.task_outputs o JOIN wf.tasks t USING (plan_id, task_id),
         jsonb_array_elements(coalesce(o.output->'assets', '[]')) a
    WHERE o.plan_id = p_plan AND t.assigned_employee_id = 'emp_repurpose_studio' AND a->>'format' = 'linkedin_post'
  ) s ORDER BY pref, created_at DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION wf.start_linkedin_publication(p_plan uuid, p_requested_by text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  p wf.plans;
  v_post jsonb;
  v_id uuid;
BEGIN
  IF coalesce(trim(p_requested_by), '') = '' THEN
    RAISE EXCEPTION 'requested_by is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM wf.plans WHERE plan_id = p_plan FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan % not found', p_plan USING ERRCODE = 'no_data_found';
  END IF;
  IF p.status <> 'completed' THEN
    RAISE EXCEPTION 'plan is %; only plans whose final deliverables were approved can be published', p.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_post := wf.find_linkedin_post(p_plan);
  IF v_post IS NULL OR length(v_post->>'text') < 1 THEN
    RAISE EXCEPTION 'plan has no LinkedIn post to publish' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF length(v_post->>'text') > 3000 THEN
    RAISE EXCEPTION 'post has % characters; LinkedIn allows 3000', length(v_post->>'text') USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM wf.publications WHERE plan_id = p_plan AND channel = 'linkedin' AND status IN ('pending', 'published')) THEN
    RAISE EXCEPTION 'this plan is already published or being published on LinkedIn' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO wf.publications (plan_id, task_id, channel, content, image_file, requested_by)
  VALUES (p_plan, v_post->>'task_id', 'linkedin', v_post->>'text', v_post->>'image_file', p_requested_by)
  RETURNING publication_id INTO v_id;
  PERFORM wf.log_event(p_plan, v_post->>'task_id', 'publication_started',
                       jsonb_build_object('publication_id', v_id, 'channel', 'linkedin', 'requested_by', p_requested_by));
  RETURN jsonb_build_object('publication_id', v_id, 'plan_id', p_plan, 'task_id', v_post->>'task_id', 'text', v_post->>'text',
                            'image_file', v_post->>'image_file');
END $$;

CREATE OR REPLACE FUNCTION wf.finish_publication(p_publication uuid, p_ok boolean, p_external_id text, p_url text, p_error text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  x wf.publications;
BEGIN
  UPDATE wf.publications
  SET status = CASE WHEN p_ok THEN 'published' ELSE 'failed' END,
      external_id = p_external_id, url = p_url, error = left(p_error, 2000),
      published_at = CASE WHEN p_ok THEN now() END
  WHERE publication_id = p_publication AND status = 'pending'
  RETURNING * INTO x;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication % is not pending', p_publication USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM wf.log_event(x.plan_id, x.task_id, CASE WHEN p_ok THEN 'publication_published' ELSE 'publication_failed' END,
                       jsonb_build_object('publication_id', x.publication_id, 'url', x.url, 'error', x.error));
  RETURN to_jsonb(x) - 'content';
END $$;

CREATE OR REPLACE FUNCTION wf.api_publications(p_plan uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'plan_id', p_plan,
    'linkedin_post', wf.find_linkedin_post(p_plan),
    'can_publish_linkedin', coalesce((SELECT status = 'completed' FROM wf.plans WHERE plan_id = p_plan), false)
       AND wf.find_linkedin_post(p_plan) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM wf.publications WHERE plan_id = p_plan AND channel = 'linkedin' AND status IN ('pending', 'published')),
    'publications', (SELECT coalesce(jsonb_agg(to_jsonb(x) - 'content' ORDER BY x.created_at DESC), '[]')
                     FROM wf.publications x WHERE x.plan_id = p_plan));
$$;
