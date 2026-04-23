-- render_logs
--
-- Persistent diagnostic log for the Remotion render pipeline.
-- Railway runtime logs are ephemeral (wiped on container replacement),
-- so we persist the critical diagnostic data here instead.
--
-- Lifecycle of a row:
--   1. INSERT on render start (status='started', edit_plan captured)
--   2. UPDATE after S3 upload (status='uploaded', clip_diagnostics filled)
--   3. UPDATE after Lambda submission (status='submitted', lambda_render_id + remotion_props)
--   4. UPDATE on terminal state (status='done' or 'failed', completed_at set)
--
-- Run this in the Supabase SQL editor to create the table.

CREATE TABLE IF NOT EXISTS render_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  render_id text NOT NULL UNIQUE,     -- our local ID, e.g. remotion_1712345_abc123
  lambda_render_id text,              -- Remotion Lambda's render ID (after submit)

  -- Request context
  platform text NOT NULL,             -- tiktok, ig_reels, youtube_shorts, etc.
  mode text NOT NULL,                 -- game_day, our_story, quick_hit, showcase

  -- The golden diagnostic data: exactly what Claude asked Remotion to do
  edit_plan jsonb NOT NULL,           -- clips[], textOverlays[], musicUrl, etc.

  -- Pipeline progress
  status text NOT NULL DEFAULT 'started',   -- started | uploaded | submitted | done | failed
  stages jsonb NOT NULL DEFAULT '[]'::jsonb, -- append-only event timeline

  -- What actually got rendered
  clip_diagnostics jsonb,             -- per-clip: s3 upload result, url, size, errors
  remotion_props jsonb,               -- final props sent to renderMediaOnLambda

  -- Outcome
  output_url text,                    -- public S3 URL of finished video (status=done)
  error text,                         -- error message (status=failed)

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Enable RLS (required by Supabase security policy).
-- The backend uses supabaseAdmin (service role key) which bypasses RLS,
-- so this just prevents the "RLS not enabled" warning without breaking anything.
ALTER TABLE render_logs ENABLE ROW LEVEL SECURITY;

-- Indexes: we query by render_id (status polling) and recent failures (debugging).
CREATE INDEX IF NOT EXISTS idx_render_logs_render_id ON render_logs(render_id);
CREATE INDEX IF NOT EXISTS idx_render_logs_status ON render_logs(status);
CREATE INDEX IF NOT EXISTS idx_render_logs_created_at ON render_logs(created_at DESC);

-- Useful debugging view: most recent failed renders with their edit plans.
CREATE OR REPLACE VIEW render_logs_recent_failures AS
SELECT
  render_id,
  lambda_render_id,
  platform,
  mode,
  error,
  jsonb_array_length(edit_plan->'clips') AS clip_count,
  clip_diagnostics,
  stages,
  created_at,
  completed_at
FROM render_logs
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 50;
