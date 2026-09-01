-- ═══════════════════════════════════════════════════════════════
-- Household — Initial Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ═══════════════════════════════════════════════════════════════

-- ─── Services ────────────────────────────────────────────────
create table if not exists services (
  id              text primary key,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nickname        text not null default '',
  category        text not null default 'OTHER',
  provider        text not null default '',
  plan_name       text not null default '',
  status          text not null default 'ACTIVE',
  amount_cents    integer not null default 0,
  billing_frequency text not null default 'MONTHLY',
  start_date      text not null default '',
  benefit_end_date text not null default '',
  contract_end_date text not null default '',
  exit_fee_cents  integer not null default 0,
  account_number  text not null default '',
  meter_identifier text not null default '',
  notes           text not null default '',
  summary         text,
  custom_fields   jsonb not null default '[]',
  tariff_history  jsonb not null default '[]',
  bill_avg_monthly_cents integer,
  bill_count      integer,
  created_at      text not null default '',
  updated_at      text not null default ''
);

-- ─── Bills ───────────────────────────────────────────────────
create table if not exists bills (
  id              text primary key,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  service_id      text not null references services(id) on delete cascade,
  period_start    text not null default '',
  period_end      text not null default '',
  total_cents     integer not null default 0,
  usage_quantity  double precision,
  usage_unit      text,
  usage_days      integer,
  line_items      jsonb not null default '[]',
  notes           text not null default '',
  created_at      text not null default ''
);

-- ─── Documents ───────────────────────────────────────────────
create table if not exists documents (
  id              text primary key,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  service_id      text not null references services(id) on delete cascade,
  title           text not null default '',
  doc_types       jsonb not null default '[]',
  doc_date        text not null default '',
  ocr_text        text not null default '',
  file_name       text not null default '',
  mime_type       text not null default '',
  file_size       integer not null default 0,
  insights        jsonb not null default '[]',
  user_edits      jsonb not null default '{}',
  created_at      text not null default ''
);

-- ─── Files metadata ──────────────────────────────────────────
-- Actual binary files live in Supabase Storage bucket "documents"
create table if not exists files (
  id              text primary key,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  mime_type       text not null default '',
  file_name       text not null default '',
  file_size       integer not null default 0
);

-- ═══════════════════════════════════════════════════════════════
-- Row Level Security — each user sees ONLY their own data
-- ═══════════════════════════════════════════════════════════════

alter table services enable row level security;
alter table bills enable row level security;
alter table documents enable row level security;
alter table files enable row level security;

-- Services
create policy "Users see own services"   on services for select using (auth.uid() = user_id);
create policy "Users insert own services" on services for insert with check (auth.uid() = user_id);
create policy "Users update own services" on services for update using (auth.uid() = user_id);
create policy "Users delete own services" on services for delete using (auth.uid() = user_id);

-- Bills
create policy "Users see own bills"   on bills for select using (auth.uid() = user_id);
create policy "Users insert own bills" on bills for insert with check (auth.uid() = user_id);
create policy "Users update own bills" on bills for update using (auth.uid() = user_id);
create policy "Users delete own bills" on bills for delete using (auth.uid() = user_id);

-- Documents
create policy "Users see own documents"   on documents for select using (auth.uid() = user_id);
create policy "Users insert own documents" on documents for insert with check (auth.uid() = user_id);
create policy "Users update own documents" on documents for update using (auth.uid() = user_id);
create policy "Users delete own documents" on documents for delete using (auth.uid() = user_id);

-- Files
create policy "Users see own files"   on files for select using (auth.uid() = user_id);
create policy "Users insert own files" on files for insert with check (auth.uid() = user_id);
create policy "Users update own files" on files for update using (auth.uid() = user_id);
create policy "Users delete own files" on files for delete using (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════════════════════════════

create index if not exists idx_services_user on services(user_id);
create index if not exists idx_bills_user on bills(user_id);
create index if not exists idx_bills_service on bills(service_id);
create index if not exists idx_documents_user on documents(user_id);
create index if not exists idx_documents_service on documents(service_id);
create index if not exists idx_files_user on files(user_id);

-- ═══════════════════════════════════════════════════════════════
-- Storage bucket for document files (PDFs, images)
-- Run this separately in the SQL Editor:
-- ═══════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- Storage RLS: users can only access files in their own path
create policy "Users upload own files"
  on storage.objects for insert
  with check (bucket_id = 'documents' and auth.uid() is not null);

create policy "Users read own files"
  on storage.objects for select
  using (bucket_id = 'documents' and auth.uid() is not null);

create policy "Users delete own files"
  on storage.objects for delete
  using (bucket_id = 'documents' and auth.uid() is not null);
