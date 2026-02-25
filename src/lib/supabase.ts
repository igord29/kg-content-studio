import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Public client — respects RLS policies */
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);

/** Admin client — bypasses RLS. Falls back to anon key if service role key not set. */
export const supabaseAdmin: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey || supabaseAnonKey,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export type FinishedVideo = {
  id: string;
  title: string;
  platform: 'tiktok' | 'ig_reels' | 'youtube_shorts' | 'twitter';
  edit_mode: 'game_day' | 'our_story' | 'quick_hit' | 'showcase';
  storage_path: string;
  public_url: string;
  thumbnail_url: string | null;
  duration_sec: number | null;
  score: number | null;
  review_notes: string | null;
  revision_count: number;
  tags: string[];
  source_video_ids: string[];
  render_id: string | null;
  created_at: string;
  updated_at: string;
};

export type RawUpload = {
  id: string;
  original_filename: string;
  storage_path: string;
  public_url: string;
  duration_sec: number | null;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  pipeline_run_id: string | null;
  created_at: string;
};
