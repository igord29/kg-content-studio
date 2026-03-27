import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('SUPABASE_URL or SUPABASE_ANON_KEY not set — Supabase client will be unavailable');
}

/** Public client — respects RLS policies */
export const supabase: SupabaseClient = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null as unknown as SupabaseClient;

/** Admin client — bypasses RLS. Falls back to anon key if service role key not set. */
export const supabaseAdmin: SupabaseClient = supabaseUrl && supabaseAnonKey
  ? createClient(
      supabaseUrl,
      supabaseServiceKey || supabaseAnonKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
  : null as unknown as SupabaseClient;

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

export type GeneratedContent = {
  id: string;
  platform: string;
  content: string;
  topic: string | null;
  image_urls: string[];
  image_prompts: string[];
  image_styles: string[];
  content_type: 'post' | 'blog' | 'script' | 'newsletter' | 'caption';
  word_count: number | null;
  created_at: string;
  updated_at: string;
};

export type ContentFeedback = {
  id: string;
  content_id: string | null;
  rating: 'positive' | 'negative';
  notes: string | null;
  platform: string | null;
  content_type: string | null;
  content_snippet: string | null;
  created_at: string;
};
