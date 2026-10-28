# Breakout — YouTube niche & competitor tracker

Describe your niche, or track specific channels. Breakout finds the videos that **break out**: the ones beating their own channel's **normal** views, **from any channel**. It uses AI to explain **why they worked**, with three ideas you could make next. You can **watch them right in the app**, and new breakouts arrive as **Telegram alerts**.

It is an installable phone app (PWA) that runs on free tiers:

| Piece | Used for | Free tier |
| --- | --- | --- |
| **YouTube Data API v3** | Channel stats, latest uploads, top comments | 10,000 units/day. One channel check costs 3. |
| **Gemini Flash** | "Why did it work?" (reads the thumbnail, title, stats and comments) | Rate-limited free tier |
| **Supabase** | Sign-in (emailed 6-digit code) and the database, with row-level security | 2 projects, 500 MB |
| **Telegram Bot API** | Breakout alerts, with a "Why did it work?" button | Free |
| **Cloudflare Workers** | Serving the app, the API, and the check every 15 minutes | 100,000 requests/day |

**No-setup mode:** choose *Use without an account* and paste your own free YouTube key (and a Gemini key for the analysis). Everything is stored on that device, and channels are checked whenever you open the app. Telegram alerts need the server.

## Two ways to find outliers

- **Niches (no competitors needed):** just type your niche the way you'd search YouTube, e.g. "budget cooking" (add more with commas for a wider net). Breakout searches YouTube for the niche's most-watched videos of the last 30 days and keeps the ones beating their own channel's normal. Small channels with one big hit stand out the most.
  - A rough first pass (each channel's lifetime average views per video) only picks candidates.
  - Every candidate's channel is then checked against its 20 latest uploads (up to 20 channels per search), and only those real scores count. Lifetime averages inflate channels that have grown, which is why big channels used to show scores like 250×.
  - About **130 quota units per scan**, because a YouTube search costs 100.
  - Each niche is searched again every 12 hours, or when you tap refresh (at most once an hour).
- **Tracked channels:** follow specific competitors closely. They're checked every 4 hours, at 3 units each. From any outlier, tap **Track this channel**.

**Language:** pick one with 🌐 on the Outliers screen or in Settings (it starts as your browser's language). Niche searches ask YouTube for that language first (`relevanceLanguage`). The feed hides videos that are clearly in another language: it uses the creator's own language setting when there is one, otherwise it reads the writing system (Cyrillic, Arabic, Japanese…) or common words (English, Spanish, German…) in the title and description. Videos it can't place stay visible. The title wins over YouTube's language setting, which many creators leave on a default. Changing the language searches your niches again.

- **Hide mixed-language videos** (on by default): with a language chosen, titles that mix in another alphabet are left out, e.g. Hindi words in an English title.
- **Never show a language**: tap **Hide Hindi videos** (or any language) on a video, or manage the list in Settings. It applies even with "Any language" and to titles that only partly use that language.
- Telegram alerts follow the same rules.

**Leave out:** give a niche words to leave out, e.g. "history" without "marvel, anime". They're added to the YouTube search as `-marvel -anime` and checked again on what comes back (whole words and longer forms: "movie" also catches "movies").

**Sort and channel size:** sort by highest score, rising fastest, most views or newest, and show only channels under 10K / 100K / 1M subscribers. A big outlier on a small channel is usually the easiest to learn from. Both choices are remembered on the device.

**🔥 Rising now:** Breakout keeps a short view history for each candidate (up to 12 readings) and re-reads the view counts of recent outliers in batches (1 YouTube unit per 50 videos). The server does this twice an hour; in this-device mode it happens when you open the app or tap refresh. A video is **rising** when it's gaining views at least 1.2× faster than its own average since publishing. Most videos slow down over time, so speeding up means it has caught a second wind. Rising videos get a 🔥 badge with views per hour, and the video screen shows the speed now vs. its average with a small chart. With Telegram connected you get one "Rising now" alert per video.

Tap a video to **play it inside the app** (YouTube's embedded player). A few videos have embedding turned off by their owner; use **Open in YouTube** for those.

## Turning outliers into videos

- **💡 Ideas board:** "Why did it work?" ends with three ideas for your channel. Tap **Save** (or **Save all to Ideas**) and they land on the **Ideas** tab. Each idea keeps the video it came from and its title formula. Move ideas through **To make → Making → Published**, add notes (hook, thumbnail, script points), or add your own with **+ New**.
- **📊 Weekly report:** the **Weekly** tab shows each niche's breakouts of the last 7 days, best first, and what their titles share.
  - The free part counts title patterns, e.g. "4 of 6 have a number", "3 of 6 mention money", a question, first person, a time frame. A pattern only counts when most of the breakouts use it, and more often than the niche's other videos do. It also lists the words the titles share, and the title formulas from your analyses.
  - **✨ What do they have in common?** asks Gemini once for the whole week: one sentence per niche and one video idea, which you can save to the Ideas board.
  - With Telegram connected, the report arrives **every Monday morning** (from 08:00 UTC), with the AI summary when the server has a Gemini key. Send `/report` to the bot to get it at any time, and turn it off with **Settings → Weekly report**.
- **📺 Suggested channels:** the **Channels** tab suggests small channels (under 100K subscribers) that you don't track yet, based on the outliers you **open, save, analyse and take ideas from**. Each one says why, e.g. "You opened 3 of their videos · 2 outliers · best 14×". Tap **Track** to follow it closely, or ✕ to never see it again (undo in **Settings → Hidden suggestions**).
  - **Find more like these** searches YouTube for the words your favourite outliers share and keeps the small channels with a breakout. It works like a niche scan, so it costs about 130 quota units, and the server allows it once every 30 minutes.

## How outliers are scored

- **Tracking:** for every tracked channel, Breakout reads the latest 50 uploads.
- **Typical views:** the channel's typical views is the **median of its videos that are at least a week old**, worked out separately for long-form videos and Shorts (up to 3 minutes). A single viral hit doesn't skew it.
- **Age adjustment:** a 3-day-old video hasn't had its full run yet. Breakout assumes a typical video has about a third of its first-month views by day 3, half by day 7 and all of them by day 28 (a square-root curve).
- **Score:** views ÷ (typical views × that age factor). **14×** means fourteen times what this channel normally gets at that age.
- **Outlier:** a video at or above your threshold (3× by default) with at least your minimum views (1K by default). Shorts can be included or left out.
- **Alerts:** you're alerted once per video, and only for breakouts from the last 14 days. Videos that were already outliers when you added a channel don't trigger alerts.

The age curve is a heuristic, not YouTube's internal data. The maths is in [`public/js/score.js`](public/js/score.js) and is unit-tested.

## Try it locally

From the repository folder:

```bash
cd breakout
```

```bash
npm start
```

Then open http://localhost:8080 and choose *Use without an account*. To run the tests:

```bash
npm test
```

## Set it up properly (free)

### 1. Supabase — sign-in and database

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste [`supabase/schema.sql`](supabase/schema.sql) → **Run**. Run it again after updating Breakout: it only adds what's missing (new tables and columns) and keeps your data.
3. **Authentication → Emails → Templates**: in *Magic Link* and *Confirm signup*, add the code to the email, for example `<p>Your Breakout code: <b>{{ .Token }}</b></p>`. The app signs in with this code rather than a link, which would open the browser instead of the installed app.
4. **Project Settings → API keys**: copy the project URL, the anon/publishable key and the service_role/secret key.

### 2. YouTube Data API key

1. In [Google Cloud Console](https://console.cloud.google.com), create a project.
2. **APIs & Services → Library → "YouTube Data API v3" → Enable**.
3. **Credentials → Create credentials → API key**.

### 3. Gemini key (for "Why did it work?")

Create one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

### 4. Telegram bot (for alerts)

In Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot` → pick a name and a username ending in `bot`. Copy the **token** and the **username**.

### 5. Deploy with GitHub (no command line)

[`.github/workflows/breakout-deploy.yml`](../.github/workflows/breakout-deploy.yml) tests, deploys and registers the Telegram webhook on every push that changes `breakout/`. You can also run it from the **Actions** tab.

1. In the Cloudflare dashboard, open **Workers & Pages** once so your free `*.workers.dev` address exists.
2. **My Profile → API Tokens → Create Token** → template **"Edit Cloudflare Workers"**. Your Account ID is on the Workers & Pages page.
3. In the GitHub repo, go to **Settings → Secrets and variables → Actions** and add:

| Secrets | Variables |
| --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (required) | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| `YOUTUBE_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (for accounts and tracking) | `TELEGRAM_BOT_USERNAME` |
| `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN` (optional) | `APP_URL`, `GEMINI_MODEL` (optional) |

4. **Actions → Deploy Breakout to Cloudflare → Run workflow**. The run summary shows the address.
5. Open the address on your phone and add it to the home screen. Then sign in, and go to **Settings → Connect Telegram → Start**.

From your own computer instead: put the values in `wrangler.toml` `[vars]`, then run `npx wrangler secret put …` for each secret and `npx wrangler deploy`.

| Without… | What happens |
| --- | --- |
| `YOUTUBE_API_KEY` or the Supabase settings | The app offers only the own-keys mode. |
| `GEMINI_API_KEY` | The "Why did it work?" button is hidden. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME` | No alerts. |

## Quota and limits

These are set in `wrangler.toml` `[vars]`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `REFRESH_HOURS` | 4 | Each channel is re-checked about this often |
| `BATCH_SIZE` | 6 | Channels per 15-minute run, which keeps each run inside Workers' free-plan limits |
| `MAX_CHANNELS` | 30 | Per user |
| `ANALYSES_PER_DAY` | 25 | Per user, to protect the shared Gemini quota |
| `NICHE_REFRESH_HOURS` | 12 | How often each niche is searched (one niche per hourly run) |
| `MAX_NICHES` | 8 | Niches with search words per user |

**Quota maths:** a niche scan costs about 130 units and runs twice a day, so a niche uses about 260 units a day: 20 niches use about half the free quota. A channel check costs 3 units, and each channel is checked 6 times a day, so it uses 18 units a day. The free 10,000 units/day therefore covers about **550 tracked channels** across all users. Each 15-minute run handles 6 channels, which is up to 576 checks a day. That keeps up with about 96 channels at the 4-hour interval. Beyond that, raise `BATCH_SIZE` (paid Workers plans allow more subrequests) or `REFRESH_HOURS`.

Adding a channel by an old-style `/c/` link uses YouTube search (100 units). @handles, channel links and video links cost 1–2 units.

## How the pieces fit

```
phone (PWA)
  ├─ Supabase Auth  ── email code → session
  ├─ Supabase REST  ── niches, channels, videos, settings (row-level security: own rows only)
  └─ Worker /api/*  ── checks the session, holds the YouTube / Gemini / Telegram keys
        ├─ /channels  resolve @handle/link → latest 50 uploads → typical views → scores
        ├─ /refresh   re-check now (rate-limited to once every 10 minutes)
        ├─ /niches/scan  search a niche for outliers from any channel (once per 30 minutes)
        ├─ /analyse   thumbnail + stats + top comments + the channel's other titles → Gemini → saved
        ├─ /report/summary  this week's breakouts → Gemini: what each niche's share (cached 30 minutes)
        ├─ /similar   "Find more like these": a niche-style search → small channels
        └─ /telegram  link codes, webhook (/start, /stop, "Why did it work?" button)
  cron */15 min → channels due for a check → new breakouts → Telegram
  cron hourly   → one niche due for a search → new breakouts → Telegram
  cron :22/:52  → re-read view counts of recent outliers → "Rising now" → Telegram
  cron hourly   → Monday reports that are due (4 per run) → Telegram
```

| Path | Purpose |
| --- | --- |
| `public/js/score.js` | Typical views, age-adjusted scores, outlier and alert rules — unit-tested |
| `public/js/youtube.js` | YouTube client: parses any channel/video link, quota-aware calls, friendly errors |
| `public/js/analyse.js` | Gemini prompt, response schema and clean-up for "Why did it work?" |
| `public/js/tracker.js` | One channel check (3 units) |
| `public/js/trend.js` | View history, views per hour, "rising" rule, re-scoring with fresh stats, sparkline |
| `public/js/lang.js` | Video language: YouTube's field, else script / common-word detection; the feed filter |
| `public/js/report.js` | Weekly report: breakouts per niche, shared title patterns and words, the AI summary prompt |
| `public/js/ideas.js` | Idea board stages, saving ideas from an analysis |
| `public/js/similar.js` | Suggested channels: interest from opens, saves, analyses and ideas; the "more like these" search |
| `public/js/discover.js` | Niche scan: search → stats → lifetime-average score → re-check the top channels (≈130 units) |
| `public/js/backend.js` | Cloud backend (Supabase over plain `fetch` + the Worker) and the own-keys backend (IndexedDB) |
| `worker/index.js`, `worker/telegram.js` | API, cron and Telegram |
| `supabase/schema.sql` | Tables, row-level security and column-level update rights |
| `tests/` | Unit and Worker tests with fake YouTube and Supabase |

No dependencies and no build step: plain HTML, CSS and ES modules, with the same design system as Budgie and Shoebox.
