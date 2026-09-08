-- ═══════════════════════════════════════════════════════════════
-- User Settings — stores AI config per user (encrypted at rest)
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ═══════════════════════════════════════════════════════════════

create table if not exists user_settings (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  ai_provider_id  text,          -- 'anthropic', 'openai', 'gemini', 'openai-compatible'
  ai_api_key      text,          -- encrypted at rest by Supabase
  ai_model_id     text,          -- specific model or 'auto'
  ai_base_url     text,          -- only for openai-compatible
  updated_at      timestamptz not null default now()
);

-- RLS: each user sees only their own settings
alter table user_settings enable row level security;

create policy "Users see own settings"
  on user_settings for select using (auth.uid() = user_id);
create policy "Users insert own settings"
  on user_settings for insert with check (auth.uid() = user_id);
create policy "Users update own settings"
  on user_settings for update using (auth.uid() = user_id);
create policy "Users delete own settings"
  on user_settings for delete using (auth.uid() = user_id);
