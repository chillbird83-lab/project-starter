---
name: web-scraper
description: Scrape web pages into clean Markdown, crawl one site or several sites into folders of Markdown, and research competitors from their websites. Use when the user asks to scrape, crawl, archive or convert websites to Markdown, find or compare competitors, or when a page needs JavaScript rendering to read.
---

# Web scraper

Free, local Firecrawl-style scraping: URL in, clean Markdown out, plus single-site
crawls and multi-site batches.

## Running the script

Everything is installed in a virtual environment inside this skill's folder. Do not
pip install anything. Run the script with that environment's Python, using this
skill's base directory:

- macOS/Linux: `<skill-dir>/.venv/bin/python <skill-dir>/scripts/scrape.py ...`
- Windows: `<skill-dir>\.venv\Scripts\python <skill-dir>\scripts\scrape.py ...`

Below, `scrape.py` is short for that full command. Output folders are created in
the current working directory.

## Commands

One page (prints Markdown, or saves it with --out):

    scrape.py scrape <url> [--render auto|always|never] [--out page.md]

One site (same domain only, breadth-first):

    scrape.py crawl <url> [--max-pages 20] [--prefix /docs/] [--focus pricing,features] [--out-dir scraped]

Several sites, one subfolder each, priority pages first:

    scrape.py batch <sites.txt> [--max-pages 15] [--focus pricing,features] [--out-dir competitors]

sites.txt has one URL or domain per line; lines starting with # are ignored.
Default focus keywords for batch cover pricing, plans, features, product,
solutions, about, customers, case studies, integrations, comparisons, blog
and careers.

Output for each site: one .md file per page, index.json (url, title, description,
file), and failed.json listing pages that could not be fetched and why. batch also
writes summary.json with page and failure counts per site.

## Defaults and limits

- Use `--render auto` (the default): plain HTTP first, a browser only when the page
  looks empty. Use `always` only when content is clearly missing.
- For a single page the built-in web fetch can read, prefer the built-in tool.
- Pass `--prefix` when the user wants only one section of a site.
- Keep `--max-pages` modest (20 for crawl, 15 per site for batch) unless the user
  asks for more.
- robots.txt is respected automatically and the delay is at least 1 second. Do not
  remove either.
- Do not scrape pages behind logins, and do not try to defeat bot protection.

## Finding competitors (when the user doesn't know them)

1. Understand the user's business. If they give their own website, scrape its
   homepage and features/pricing pages first. Otherwise ask for one line on what
   they sell, who buys it, and their location if they serve a local market.
2. Use the built-in web search (not this script) from several angles:
   - "<category> alternatives", "<their brand> alternatives", "<their brand> vs"
   - "best <category> for <customer type>", or "<service> near <town>" if local
   - review and directory category pages (G2, Capterra, Trustpilot, Product Hunt)
   - Reddit or forum threads where buyers ask for recommendations
3. Build a shortlist of 5–10, grouped as direct competitors (same product, same
   customer), indirect (different product, same problem) and larger players.
   For each, note why it's included and where it was found.
4. Show the shortlist and let the user confirm or trim it before crawling.
5. Write the confirmed sites to sites.txt and follow "Competitor research".

## Competitor research

1. Run `batch` on the sites file (15–25 pages per site is usually enough).
2. Check summary.json. A site with 0–1 pages was probably blocked; see the
   Firecrawl section rather than retrying the script.
3. Read each site's index.json, then the most relevant pages first: pricing,
   features, about, customers.
4. Compare on positioning and target customer; products and key features;
   pricing and plans (note "contact sales" where prices are hidden); proof points
   (customers, case studies); and recent focus (blog topics, open roles).
5. Cite the page URL for each claim, and say where information wasn't published.

## Firecrawl (if connected): fallback only

Firecrawl costs credits, so use it sparingly:
- Discovery: use the built-in web search first. Use Firecrawl search only if
  built-in search is unavailable or comes back thin.
- Blocked pages: if failed.json shows "blocked by bot protection", HTTP 403 or 429
  for a page that matters (e.g. a competitor's pricing page), scrape that single
  URL with Firecrawl's scrape tool.
- Never use Firecrawl for whole-site crawls or batches.
- At the end of the task, tell the user which URLs went through Firecrawl.

## Troubleshooting

- Every URL fails with connection errors: the machine is offline, or a VPN or
  proxy is interfering. Tell the user.
- Browser errors saying the executable doesn't exist: run
  `<skill-dir>/.venv/bin/playwright install chromium`
  (Windows: `<skill-dir>\.venv\Scripts\playwright install chromium`).
- Browser errors about missing system libraries (Linux): ask the user to run
  `sudo <skill-dir>/.venv/bin/playwright install-deps chromium`.
- If the browser can't be fixed, continue with `--render never` and say that
  JavaScript-heavy pages may be incomplete.
