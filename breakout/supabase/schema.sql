-- Breakout database. Paste into Supabase → SQL Editor → Run.
-- People can only ever see their own rows (row-level security). The Worker writes channel and video
-- data with the service-role key after checking who is asking.

create table if not exists public.niches (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  -- What Breakout searches YouTube for; the app sets it to the niche name ("budget cooking").
  keywords   text not null default '' check (char_length(keywords) <= 200),
  scanned_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.channels (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  niche_id         uuid references public.niches (id) on delete set null,
  yt_channel_id    text not null,
  title            text not null default '',
  handle           text not null default '',
  thumb            text not null default '',
  subscribers      bigint,
  video_count      integer,
  uploads_playlist text not null default '',
  baseline_long    bigint not null default 0,
  baseline_short   bigint not null default 0,
  checked_at       timestamptz,
  created_at       timestamptz not null default now(),
  unique (user_id, yt_channel_id)
);
create index if not exists channels_due on public.channels (checked_at nulls first);

create table if not exists public.videos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Set for videos of tracked channels; empty for videos found by a niche scan.
  channel_id   uuid references public.channels (id) on delete cascade,
  niche_ids    uuid[] not null default '{}',  -- niches whose search found it (a video can be in several)
  source       text not null default 'channel' check (source in ('channel', 'search')),
  yt_video_id  text not null,
  yt_channel_id text not null default '',
  channel_title text not null default '',
  channel_subs bigint,
  baseline     bigint not null default 0,
  baseline_kind text not null default 'median' check (baseline_kind in ('median', 'average')),
  lang         text not null default '',  -- YouTube's audio/default language, if the creator set one
  title        text not null default '',
  description  text not null default '',
  tags         text[] not null default '{}',
  thumb        text not null default '',
  published_at timestamptz not null,
  duration_s   integer not null default 0,
  is_short     boolean not null default false,
  views        bigint not null default 0,
  likes        bigint,
  comments     bigint,
  score        real not null default 0,
  is_outlier   boolean not null default false,
  alerted_at   timestamptz,
  analysis     jsonb,
  analysed_at  timestamptz,
  saved        boolean not null default false,
  updated_at   timestamptz not null default now(),
  unique (user_id, yt_video_id)
);
create index if not exists videos_channel on public.videos (channel_id, published_at desc);
create index if not exists videos_outliers on public.videos (user_id, is_outlier, published_at desc);
create index if not exists videos_niches on public.videos using gin (niche_ids);
create index if not exists niches_due on public.niches (scanned_at nulls first);

-- Upgrading a database made with the first version of this file:
alter table public.niches add column if not exists keywords text not null default '';
alter table public.niches add column if not exists scanned_at timestamptz;
alter table public.niches drop constraint if exists niches_name_check;
alter table public.niches add constraint niches_name_check check (char_length(name) between 1 and 80);
alter table public.videos alter column channel_id drop not null;
alter table public.videos drop column if exists niche_id;
alter table public.videos add column if not exists niche_ids uuid[] not null default '{}';
alter table public.videos add column if not exists source text not null default 'channel';
alter table public.videos add column if not exists yt_channel_id text not null default '';
alter table public.videos add column if not exists channel_title text not null default '';
alter table public.videos add column if not exists channel_subs bigint;
alter table public.videos add column if not exists baseline bigint not null default 0;
alter table public.videos add column if not exists baseline_kind text not null default 'median';
alter table public.videos add column if not exists lang text not null default '';
alter table public.profiles add column if not exists language text not null default 'any';
alter table public.profiles add column if not exists hide_mixed boolean not null default true;
alter table public.profiles add column if not exists hide_languages text[] not null default '{}';

create table if not exists public.profiles (
  user_id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  email           text,
  threshold       real not null default 3 check (threshold between 1.5 and 100),
  min_views       integer not null default 1000 check (min_views >= 0),
  include_shorts  boolean not null default true,
  alerts          boolean not null default true,
  language        text not null default 'any',  -- 'any' or a 2-letter code; favours and filters that language
  hide_mixed      boolean not null default true, -- hide titles mixing in another alphabet
  hide_languages  text[] not null default '{}',  -- never show these languages
  last_refresh_at timestamptz,
  updated_at      timestamptz not null default now()
);

-- Telegram chat links are written only by the Worker (after the user taps the bot link).
create table if not exists public.telegram_links (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  chat_id         bigint,
  link_code       text unique,
  link_created_at timestamptz,
  linked_at       timestamptz
);

-- Removing a niche takes it off its videos; videos no niche or tracked channel needs any more go too.
create or replace function public.forget_niche() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.videos set niche_ids = array_remove(niche_ids, old.id) where user_id = old.user_id and old.id = any (niche_ids);
  delete from public.videos where user_id = old.user_id and channel_id is null and niche_ids = '{}';
  return old;
end $$;
drop trigger if exists niches_forget on public.niches;
create trigger niches_forget after delete on public.niches for each row execute function public.forget_niche();

alter table public.niches enable row level security;
alter table public.channels enable row level security;
alter table public.videos enable row level security;
alter table public.profiles enable row level security;
alter table public.telegram_links enable row level security;

drop policy if exists "own niches" on public.niches;
create policy "own niches" on public.niches for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Channels are added by the Worker (it checks them with YouTube); people can read, move and remove theirs.
drop policy if exists "read own channels" on public.channels;
create policy "read own channels" on public.channels for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "update own channels" on public.channels;
create policy "update own channels" on public.channels for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own channels" on public.channels;
create policy "delete own channels" on public.channels for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "read own videos" on public.videos;
create policy "read own videos" on public.videos for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "delete own videos" on public.videos;
create policy "delete own videos" on public.videos for delete to authenticated using (user_id = (select auth.uid()));
drop policy if exists "update own videos" on public.videos;
create policy "update own videos" on public.videos for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "read own telegram link" on public.telegram_links;
create policy "read own telegram link" on public.telegram_links for select to authenticated using (user_id = (select auth.uid()));

-- Only the "saved" flag of a video and the niche of a channel are editable from the app.
revoke update on public.videos from authenticated;
grant update (saved) on public.videos to authenticated;
revoke update on public.channels from authenticated;
grant update (niche_id) on public.channels to authenticated;
