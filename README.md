# project-starter

Two free, installable phone apps (PWAs) — no accounts, no server, no dependencies:

- **[Lectern](#lectern)** (`lectern/`) — record university lectures and keep them organised by course.
- **[Budgie](#budgie)** (repo root) — a weekly and long-term budget tracker.

## Lectern

Record your lectures on your phone, bookmark the moments that matter, take notes, and find everything again by course, week or search. Recordings stay on your phone and it works offline.

- **Recorder** – one big button; pause/resume; live waveform and timer. The screen stays on while recording (Wake Lock) and **Dim** turns it black to save battery. Audio is written to storage every 5 seconds, so if the app is closed, the browser crashes or the phone restarts, the recording is **recovered** on the next launch. A warning appears if the input is very quiet.
- **Bookmarks** – tap ⭐ Important, 🎯 Exam, ❓ Question or 📌 Note (with a label) while recording or listening; they show as ticks on the player and jump straight there (starting 3 s early).
- **Notes** – type notes during the lecture or afterwards; ⏱ inserts the current time as `[12:34]`, and every timestamp in your notes becomes a jump button.
- **Organiser** – courses with colour, emoji, lecturer, room and weekly times. Lectern uses the timetable to pre-select the class you are in and titles recordings "Lecture 1, 2, 3…". *Today* shows the class happening now, *Continue listening* and a *To review* list; *Week* shows your timetable with ✓ for every class you recorded; *Library* has full-text search across titles, notes and bookmark labels plus *To review* / *Starred* filters. Archive courses at the end of a semester.
- **Player** – keeps playing while you browse the app or lock the phone (lock-screen controls), remembers where you stopped, 0.75×–2× speed, ±15/30 s.
- **Your files** – share a recording to Drive/WhatsApp/e-mail, save it to Downloads, copy notes, remove audio but keep notes to free space, and download a **full backup** (.zip of all recordings + `lectern.json`) that you can restore on a new phone.
- Three quality levels: Saver (≈7 MB/h), Standard (≈14 MB/h, default), High (≈29 MB/h) — Opus audio, clear for speech.

### Put it on your Android phone

1. Deploy (see below), then open `https://<your-user>.github.io/project-starter/lectern/` in **Chrome**.
2. Chrome menu (⋮) → **Install app** / **Add to Home screen**. Lectern opens full screen like a normal app, works offline, and Chrome protects its storage from automatic clean-up.
3. The first time you record, allow the microphone.

Tips: keep Lectern open while recording (use **Dim** instead of locking the phone — browsers may pause the microphone for apps in the background), put the phone face up near the speaker, and make a backup from *Settings* now and then: recordings live only on the phone, and clearing Chrome's site data deletes them.

| Path | Purpose |
| --- | --- |
| `lectern/js/logic.js` | Pure logic — timetable matching, search, titles, formatting, validation — fully unit-tested |
| `lectern/js/recorder.js` | Microphone recording, crash-safe chunk saving, bookmarks, wake lock, level meter |
| `lectern/js/store.js`, `lectern/js/db.js` | State, IndexedDB storage (audio as Blobs), crash recovery, backup/restore |
| `lectern/js/player.js` | Shared audio player, resume position, lock-screen controls |
| `lectern/js/zip.js` | Minimal ZIP writer/reader for backups (unit-tested) |
| `lectern/js/views.js`, `lectern/js/sheets.js`, `lectern/js/app.js` | Screens, forms, navigation (Android back button) |

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
npm start        # Budgie: http://localhost:8080 · Lectern: http://localhost:8080/lectern/
npm test         # unit tests for both apps (Node's built-in test runner)
```

### Use it on your phone

The repo deploys itself with GitHub Pages (`.github/workflows/pages.yml`). One-time setup: in the repository go to **Settings → Pages → Build and deployment → Source: GitHub Actions**, then merge to `main`. Budgie appears at `https://<your-user>.github.io/project-starter/` and Lectern at `https://<your-user>.github.io/project-starter/lectern/`.

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

`scripts/make-icons.mjs` regenerates the PNG icons from the SVGs (`node scripts/make-icons.mjs` for Budgie, `node scripts/make-icons.mjs lectern` for Lectern; needs `playwright`; development only).
