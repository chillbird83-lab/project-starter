-- Shoebox database. Paste into Supabase → SQL Editor → Run.
-- Every row belongs to one user; row-level security means people can only ever see their own.

create table if not exists public.receipts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind         text not null default 'expense' check (kind in ('expense', 'income')),
  date         date not null,
  merchant     text not null default '' check (char_length(merchant) <= 80),
  description  text not null default '' check (char_length(description) <= 120),
  category     text not null,
  gross_pence  integer not null check (gross_pence between 0 and 999999999),
  vat_pence    integer not null default 0 check (vat_pence >= 0 and vat_pence <= gross_pence),
  business_pct smallint not null default 100 check (business_pct between 0 and 100),
  payment      text not null default '',
  vat_number   text not null default '',
  image_key    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists receipts_user_date on public.receipts (user_id, date desc);

create table if not exists public.profiles (
  user_id          uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  email            text,
  business_name    text not null default '' check (char_length(business_name) <= 80),
  vat_registered   boolean not null default false,
  vat_stagger      smallint not null default 1 check (vat_stagger in (1, 2, 3)),
  quarter_basis    text not null default 'standard' check (quarter_basis in ('standard', 'calendar')),
  reminders        boolean not null default true,
  accountant_email text not null default '',
  submitted        jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists receipts_touch on public.receipts;
create trigger receipts_touch before update on public.receipts for each row execute function public.touch_updated_at();
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

alter table public.receipts enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "own receipts" on public.receipts;
create policy "own receipts" on public.receipts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
