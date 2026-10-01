-- ═══════════════════════════════════════════════════════════════
-- Notification & Reminder columns
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ═══════════════════════════════════════════════════════════════

-- Services: add reminder frequency and last sent tracking
alter table services
  add column if not exists reminder_frequency text not null default 'BEFORE_EXPIRY',
  add column if not exists last_reminder_sent text;

-- User settings: add notification preferences
alter table user_settings
  add column if not exists notif_enabled     boolean not null default false,
  add column if not exists notif_email       text,
  add column if not exists notif_days_before integer not null default 30;
