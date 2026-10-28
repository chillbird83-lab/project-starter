# Shoebox — receipts & Making Tax Digital for UK sole traders

Snap a receipt and AI reads the **amount, VAT and category**. Shoebox files it under the matching HMRC expense category, and at the end of each quarter it exports the totals your **Making Tax Digital** quarterly update needs.

It is an installable phone app (PWA). It runs entirely on free tiers:

| Piece | Used for | Free tier |
| --- | --- | --- |
| **Gemini Flash** | Reading receipt photos and PDFs | Rate-limited free tier |
| **Supabase** | Sign-in (emailed 6-digit code) and the database, with row-level security | 2 projects, 500 MB |
| **Cloudflare R2** | Storing receipt photos | 10 GB, no download fees |
| **Resend** | Deadline reminders, emailing exports to your accountant, sign-in emails | 3,000 emails/month |
| **Cloudflare Workers** | Serving the app and the API, holding every secret | 100,000 requests/day |

It also works **without any of that**: open the app and choose *Use without an account*. Everything is then stored on that phone. Receipts are read with your own free Gemini key if you add one in Settings, or you type the details in.

## What it does

- **Scan** — take a photo or upload a photo or PDF. Gemini extracts the supplier, date, total, VAT, VAT number, category and payment method. You check it and save. The review screen flags problems such as no VAT number, foreign currency, a future date, VAT that can't be right, or something that isn't a receipt.
- **HMRC categories** — the 14 expense categories are HMRC's own self-employment fields (`costOfGoods`, `carVanTravelExpenses`, `adminCosts`…), so the totals map straight onto the quarterly update.
- **VAT-aware**
  - **VAT registered:** costs are recorded net of reclaimable VAT, and there is a VAT return card (boxes 1–9) for your VAT stagger.
  - **Not registered:** the gross amount is the cost.
- **Partly-private costs** — set the business share (for example a phone at 60%). The private part is reported as *disallowable*.
- **Client entertaining** — recorded but always disallowable, with no VAT reclaim, as HMRC requires.
- **Quarterly updates** — each quarter shows its period, deadline and status (in progress, ready to send, overdue, sent), with *year to date* totals because MTD updates are cumulative.
  - Supports standard (6 Apr – 5 Jul …) or calendar (1 Apr – 30 Jun …) quarters.
  - Can send one consolidated expenses total if your turnover is under £90,000.
- **Exports**
  - MTD summary CSV, for bridging software or your accountant.
  - JSON in the shape of HMRC's Self-Employment Business API period summary.
  - Every record as CSV (your digital records).
  - VAT return CSV.
  - Any export can be emailed to your accountant (signed-in mode).
- **Reminders** — an email 14 days and 3 days before each quarterly deadline (7 Aug, 7 Nov, 7 Feb, 7 May).
- **Backup & restore** (JSON), delete account, offline app shell, light and dark mode.

Shoebox prepares figures and keeps your records. It does **not** submit to HMRC itself. Submitting needs HMRC-recognised software, which means OAuth with HMRC, fraud-prevention headers and HMRC's production approval. Use bridging software or your accountant, or treat direct submission as a later step. This isn't tax advice.

## Try it in 10 seconds (no accounts)

From the repository folder, start the app in this-device mode:

```bash
cd shoebox
```

```bash
npm start
```

Then open http://localhost:8080. To run the tests (tax rules, AI parsing and the Worker API):

```bash
npm test
```

## Set it up properly (about 20 minutes, all free)

### 1. Supabase — sign-in and database

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste [`supabase/schema.sql`](supabase/schema.sql) → **Run**. This creates the `receipts` and `profiles` tables with row-level security.
3. **Authentication → Emails → Templates**: in *Magic Link* and *Confirm signup*, add the code to the email, for example `<p>Your Shoebox code: <b>{{ .Token }}</b></p>`. The app signs in with this code rather than a link, because a link would open the browser instead of the installed app.
4. **Authentication → Emails → SMTP settings**: turn on custom SMTP with Resend. Supabase's built-in email only sends a few messages an hour.
   - Host `smtp.resend.com`, port `465`
   - User `resend`, password = your Resend API key
   - Sender = an address on your verified domain
5. **Project Settings → API keys**: copy the project URL, the anon/publishable key and the service_role/secret key.

### 2. Resend — email

Create an account at [resend.com](https://resend.com), verify a domain you own, and create an API key.

### 3. Gemini — receipt reading

Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

**Privacy:** on Gemini's free tier, Google may use what you send to improve its products. Receipts are financial data, so switch the key to a paid (pay-as-you-go) project before real customers use the app. Flash is very cheap per receipt.

### 4a. Easiest: deploy from GitHub (no command line)

[`.github/workflows/shoebox-deploy.yml`](../.github/workflows/shoebox-deploy.yml) deploys on every push that changes `shoebox/`. You can also run it by hand from the **Actions** tab.

1. **Cloudflare dashboard → Workers & Pages.** Open it once so your free `*.workers.dev` subdomain is created.
2. **R2 → enable R2**, for receipt photos. Cloudflare asks for a payment method even on the free tier. Without R2 the app still deploys, in "this device only" mode.
3. **My Profile → API Tokens → Create Token** → template **"Edit Cloudflare Workers"**. Copy the token. Your **Account ID** is on the Workers & Pages overview page.
4. **GitHub repo → Settings → Secrets and variables → Actions**:
   - **Secrets:** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (required). Optionally `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY`.
   - **Variables** (optional): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `EMAIL_FROM`, `APP_URL` and `GEMINI_MODEL`.
5. **Actions → Deploy Shoebox to Cloudflare → Run workflow**, or re-run the last run. The run summary shows the app's address.

Add more secrets or variables later and re-run the workflow. That is how the app goes from "this device only" to accounts, cloud photos and email.

### 4b. Or deploy from your computer

#### Cloudflare — R2 and the Worker

```bash
cd shoebox
npx wrangler login
npx wrangler r2 bucket create shoebox-receipts
```

Fill in `[vars]` in [`wrangler.toml`](wrangler.toml):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `EMAIL_FROM` (for example `Shoebox <hello@yourdomain.co.uk>`)
- `APP_URL`, after the first deploy

Then add the secrets:

```bash
npx wrangler secret put GEMINI_API_KEY
```

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

```bash
npx wrangler secret put RESEND_API_KEY
```

Deploy:

```bash
npx wrangler deploy
```

The app is live at `https://shoebox.<your-subdomain>.workers.dev`. Open it on your phone and add it to the home screen:

- **iPhone:** Safari → Share → *Add to Home Screen*
- **Android:** Chrome → *Install app*

It has its own address, so it doesn't clash with Budgie.

`GEMINI_MODEL` defaults to `gemini-flash-latest`, which follows Google's newest Flash model. Set a fixed model ID if you prefer.

To run the whole stack locally, put the secrets in `.dev.vars` (git-ignored) and run `npx wrangler dev`.

| Without… | What happens |
| --- | --- |
| `GEMINI_API_KEY` | Photos are still stored and details are typed in by hand. |
| `RESEND_API_KEY` / `EMAIL_FROM` | Email export and reminders are hidden. |
| `SUPABASE_*` | The app only offers this-device mode. |

## How the pieces fit

```
phone (PWA)
  ├─ Supabase Auth  ── email code → session (access + refresh token)
  ├─ Supabase REST  ── receipts / profiles, row-level security: own rows only
  └─ Worker /api/*  ── checks the Supabase session, then:
        ├─ /scan     → R2 put  →  Gemini (image/PDF → JSON schema)  → draft
        ├─ /image/:k → R2 get   (only keys under the user's own ID)
        ├─ /email    → Resend   (only to you or your saved accountant)
        ├─ /account  → delete R2 files + Supabase user (rows cascade)
        └─ cron 08:17 UTC → reminders via Resend batch
```

| Path | Purpose |
| --- | --- |
| `public/js/tax.js` | Tax years, MTD quarters and deadlines, VAT periods, how each record counts, HMRC period summary — unit-tested |
| `public/js/categories.js` | HMRC expense categories with plain-English hints (also given to the AI) |
| `public/js/extract.js` | Gemini prompt, response schema, answer clean-up and warnings — shared by the Worker and own-key mode |
| `public/js/export.js` | CSV/JSON exports (with spreadsheet formula-injection protection) |
| `public/js/backend.js` | Cloud backend (Supabase over plain `fetch`, Worker API) and this-device backend (IndexedDB) |
| `public/js/store.js`, `views.js`, `sheets.js`, `app.js` | State, screens, sheets, wiring |
| `worker/index.js` | The API and reminder cron |
| `supabase/schema.sql` | Tables, constraints and row-level security |

The app has no dependencies or build step: plain HTML, CSS and ES modules, with the same design system as Budgie. Money is stored as integer pence and dates as `YYYY-MM-DD`.

## Assumptions and limits

- The cash basis is assumed: expenses count on the receipt date. It is the default for sole traders.
- Mileage at the simplified flat rate isn't calculated. Record fuel and running costs instead, or ask your accountant.
- Foreign-currency receipts are flagged. Enter the £ amount from your bank statement.
- VAT Flat Rate Scheme returns are worked out differently and aren't covered.
- Keep records for at least 5 years after the 31 January filing deadline. Backups and the CSV of all records help.
