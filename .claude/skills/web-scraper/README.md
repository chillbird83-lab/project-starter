# web-scraper skill: setup

Needs Python 3.10 or newer. Run once from this folder:

```bash
python3 -m venv .venv
.venv/bin/pip install httpx trafilatura markdownify beautifulsoup4 playwright
.venv/bin/playwright install chromium
```

On Windows (PowerShell), use `python -m venv .venv`, then `.venv\Scripts\pip ...` and
`.venv\Scripts\playwright install chromium`. On Linux, if the browser complains about
missing libraries, run `sudo .venv/bin/playwright install-deps chromium` once.

Quick test:

```bash
.venv/bin/python scripts/scrape.py scrape https://example.com
```

To use the skill in every project rather than just this one, copy this folder to
`~/.claude/skills/web-scraper/` and run the setup there.
