# project-starter

Free, installable phone apps (PWAs) with no dependencies:

- **[Breakout](breakout/)** (`breakout/`) — YouTube niche & competitor tracker: spots videos that beat their channel's typical views, explains why they worked with Gemini, keeps an idea board, suggests small channels to follow, and sends Telegram alerts and a weekly report. Runs on the YouTube Data API, Supabase and Cloudflare Workers (all free tiers), or with your own API keys alone. Setup guide: [breakout/README.md](breakout/README.md).
- **[Shoebox](shoebox/)** (`shoebox/`) — receipt scanner for UK sole traders: snap a receipt, AI reads the amount, VAT and category, and it exports your Making Tax Digital quarterly totals. Runs on Gemini Flash, Supabase, Cloudflare R2 + Workers and Resend (all free tiers), or on the phone alone. Setup guide: [shoebox/README.md](shoebox/README.md).
- **[Lectern](#lectern)** — record university lectures and keep them organised by course (moved to its own repository).
- **[Budgie](#budgie)** (repo root) — a weekly and long-term budget tracker. No accounts, no server.

## Lectern

Lectern now lives in its own repository, [chillbird83-lab/lectern](https://github.com/chillbird83-lab/lectern), at **https://chillbird83-lab.github.io/lectern/** — a separate address, so the installed Budgie app no longer opens Lectern links. `lectern/` here only forwards the old address to the new one.

## Budgie

A weekly and long-term budget tracker with an Apple-style design. It is an installable web app (PWA): no accounts, no server, no dependencies — your data stays on your device and it works offline.

## What it does

- **Weekly budget** – set an amount per week; every purchase is subtracted. The *Week* screen shows what is left (a draining ring), what is *safe to spend today*, and a **day-by-day ledger** with the remaining balance after each day. Browse past and future weeks.
- **Long-term plans** – budgets for several months (e.g. a 3-month winter plan, a holiday fund). Each plan shows remaining amount, pace vs. time, a month-by-month breakdown, a projection, and the daily amount still available. A plan can count all spending or only chosen categories.
- **Activity** – searchable, filterable history grouped by day; add, edit, delete (with undo).
- **Insights** – 7D / 30D / 90D / 1Y spending trend, category breakdown, weekly results and streaks, biggest expenses.
- **Everything else** – income tracking, custom categories, 22 currencies, light/dark/automatic theme, JSON backup & restore, CSV export, sample data, first-run onboarding, offline support, keyboard and screen-reader friendly.

## Run it

```bash
npm start
```

Then open http://localhost:8080. To run the unit tests for Budgie, Shoebox and Breakout (Node's built-in test runner):

```bash
npm test
```

### Use it on your phone

The repo deploys itself with GitHub Pages (`.github/workflows/pages.yml`). One-time setup: in the repository go to **Settings → Pages → Build and deployment → Source: GitHub Actions**, then merge to `main`. The app appears at `https://<your-user>.github.io/project-starter/`.

Open that link on your phone, then **iPhone:** Safari → Share → *Add to Home Screen*. **Android:** Chrome → menu → *Install app*. It then opens full screen like a native app and works offline.

To try it on your phone before publishing, run `npm start` and open `http://<your-computer-ip>:8080` while both are on the same Wi-Fi (works in the browser; installing and offline mode need HTTPS).

There is no build step: it is plain HTML, CSS and ES modules. Host the folder on any static host (GitHub Pages, Netlify, Cloudflare Pages…). Over HTTPS, open it on your phone and use **Share → Add to Home Screen** (iOS) or **Install app** (Android/desktop Chrome).

## Layout

| Path | Purpose |
| --- | --- |
| `js/calc.js` | Pure budget logic (weeks, plans, breakdowns) — fully unit-tested |
| `js/store.js` | State, persistence (`localStorage`), validation of imported data, sample data |
| `js/views.js` | Week / Plans / Activity / Insights screens |
| `js/sheets.js` | Add-transaction, plan, settings and onboarding sheets |
| `js/overlay.js`, `js/charts.js`, `js/format.js`, `js/util.js` | Sheets/alerts/toasts, SVG charts, money & date formatting, helpers |
| `css/styles.css` | Design system (SF font stack, grouped lists, frosted glass, dark mode) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installability |

Money is stored as integer cents and dates as local `YYYY-MM-DD`, so there is no floating-point drift or time-zone shifting.

`scripts/make-icons.mjs` regenerates the PNG icons from the SVGs (needs `playwright`; development only).
