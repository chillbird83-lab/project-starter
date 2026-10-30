#!/usr/bin/env python3
"""Lightweight Firecrawl-style scraper: URL -> clean Markdown, site crawls and multi-site batches."""
import argparse, asyncio, json, os, re, sys
from collections import deque
from urllib.parse import urljoin, urldefrag, urlparse
from urllib import robotparser

import httpx, trafilatura
from bs4 import BeautifulSoup
from markdownify import markdownify as md

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
SKIP_EXT = re.compile(r"\.(pdf|jpe?g|png|gif|webp|zip|mp4|svg|css|js|xml)$", re.I)
BLOCK_MARKERS = re.compile(
    r"just a moment|attention required|verify you are (a )?human|are you a robot|"
    r"access denied|cf-chl|captcha", re.I)
RENDER = ["auto", "always", "never"]
FOCUS_DEFAULT = ["pricing", "price", "plans", "features", "product", "solutions",
                 "platform", "about", "customers", "case-stud", "integrations",
                 "compare", "vs", "blog", "careers"]


def log(msg):
    print(msg, file=sys.stderr)


def host(netloc):
    return netloc.lower().removeprefix("www.")


class Browser:
    """Starts Chromium lazily, so static-only runs never need it."""
    def __init__(self):
        self.pw = self.browser = None

    async def page_html(self, url):
        if self.browser is None:
            from playwright.async_api import async_playwright
            self.pw = await async_playwright().start()
            self.browser = await self.pw.chromium.launch(headless=True)
        page = await self.browser.new_page(user_agent=UA)
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            try:
                await page.wait_for_load_state("networkidle", timeout=8000)
            except Exception:
                pass  # some sites never go idle; use what has loaded
            return page.url, await page.content()
        finally:
            await page.close()

    async def close(self):
        if self.browser:
            await self.browser.close()
            await self.pw.stop()


def to_markdown(html, url):
    # Main-content extraction first (drops navs, ads, footers)
    out = trafilatura.extract(html, url=url, output_format="markdown",
                              include_links=True, include_tables=True,
                              favor_recall=True)
    if out and len(out) > 200:
        return out
    # Fallback: crude cleanup, then convert the main area
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "nav", "footer",
                     "header", "aside", "form", "svg"]):
        tag.decompose()
    main = soup.find("main") or soup.find("article") or soup.body or soup
    return re.sub(r"\n{3,}", "\n\n", md(str(main), heading_style="ATX")).strip()


def meta(html):
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else ""
    d = soup.find("meta", attrs={"name": "description"})
    return {"title": title, "description": d.get("content", "") if d else ""}


def looks_blocked(html, markdown):
    return bool(BLOCK_MARKERS.search(html[:5000])) and len(markdown) < 1500


def links(html, base):
    for a in BeautifulSoup(html, "html.parser").find_all("a", href=True):
        link = urldefrag(urljoin(base, a["href"]))[0]
        if link.startswith("http"):
            yield link


async def load_robots(client, parsed):
    """Read robots.txt like search engines do: rules apply only if the file loads."""
    try:
        r = await client.get(f"{parsed.scheme}://{parsed.netloc}/robots.txt")
        if r.status_code == 200:
            rp = robotparser.RobotFileParser()
            rp.parse(r.text.splitlines())
            rp.modified()
            return rp
    except Exception:
        pass
    return None


async def scrape(url, render, client, browser):
    html, final, err = None, url, None
    if render != "always":
        try:
            r = await client.get(url)
            r.raise_for_status()
            ctype = r.headers.get("content-type", "")
            if "html" not in ctype:
                raise ValueError(f"not an HTML page ({ctype or 'unknown type'})")
            final, html = str(r.url), r.text
        except Exception as e:
            err = e
            if render == "never":
                raise
    thin = html is None or len(to_markdown(html, final)) < 300
    if render == "always" or (render == "auto" and thin):
        try:
            final, html = await browser.page_html(url)
        except Exception as e:
            if html is None:
                raise RuntimeError(f"static fetch: {err}; browser: {e}")
            log(f"note: browser render failed ({e}); using static HTML")
    markdown = to_markdown(html, final)
    if looks_blocked(html, markdown):
        raise RuntimeError("blocked by bot protection")
    return {"url": final, **meta(html), "markdown": markdown, "html": html}


async def crawl(start, max_pages, prefix, delay, render, client, browser, focus=None):
    p0 = urlparse(start)
    site = host(p0.netloc)
    rp = await load_robots(client, p0)
    queue, seen, pages, failed = deque([start]), {start}, [], []
    while queue and len(pages) < max_pages:
        url = queue.popleft()
        if rp and not rp.can_fetch("*", url):
            log(f"robots.txt disallows {url}")
            continue
        try:
            page = await scrape(url, render, client, browser)
        except Exception as e:
            log(f"✗ {url}: {e}")
            failed.append({"url": url, "error": str(e)[:300]})
            await asyncio.sleep(delay)
            continue
        pages.append(page)
        log(f"✓ [{len(pages)}/{max_pages}] {url}")
        for link in links(page["html"], page["url"]):
            p = urlparse(link)
            if host(p.netloc) != site or link in seen or SKIP_EXT.search(p.path):
                continue
            if prefix and not p.path.startswith(prefix):
                continue
            seen.add(link)
            if focus and any(k in p.path.lower() for k in focus):
                queue.appendleft(link)  # priority pages jump the queue
            else:
                queue.append(link)
        await asyncio.sleep(delay)
    return pages, failed


def as_doc(p):
    return f"# {p['title']}\n\nSource: {p['url']}\n\n{p['markdown']}\n"


def save_pages(pages, failed, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    index = []
    for i, p in enumerate(pages):
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", urlparse(p["url"]).path).strip("-") or "index"
        name = f"{i:03d}-{slug[:80]}.md"
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            f.write(as_doc(p))
        index.append({"url": p["url"], "title": p["title"],
                      "description": p["description"], "file": name})
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
    if failed:
        with open(os.path.join(out_dir, "failed.json"), "w", encoding="utf-8") as f:
            json.dump(failed, f, indent=2)
    return len(pages)


async def main():
    for stream in (sys.stdout, sys.stderr):  # avoid Windows console encoding errors
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scrape", help="one page")
    s.add_argument("url")
    s.add_argument("--render", choices=RENDER, default="auto")
    s.add_argument("--out")

    c = sub.add_parser("crawl", help="one site")
    c.add_argument("url")
    c.add_argument("--max-pages", type=int, default=20)
    c.add_argument("--prefix")
    c.add_argument("--focus", help="comma-separated path keywords to visit first")
    c.add_argument("--delay", type=float, default=1.0)
    c.add_argument("--render", choices=RENDER, default="auto")
    c.add_argument("--out-dir", default="scraped")

    b = sub.add_parser("batch", help="several sites, one subfolder each")
    b.add_argument("sites_file", help="text file with one URL or domain per line")
    b.add_argument("--max-pages", type=int, default=15, help="per site")
    b.add_argument("--focus", default=",".join(FOCUS_DEFAULT))
    b.add_argument("--delay", type=float, default=1.0)
    b.add_argument("--render", choices=RENDER, default="auto")
    b.add_argument("--out-dir", default="competitors")
    a = ap.parse_args()

    focus = [k.strip().lower() for k in (getattr(a, "focus", None) or "").split(",")
             if k.strip()] or None
    delay = max(getattr(a, "delay", 1.0), 1.0)

    browser = Browser()
    async with httpx.AsyncClient(headers={"User-Agent": UA},
                                 follow_redirects=True, timeout=20) as client:
        try:
            if a.cmd == "scrape":
                try:
                    doc = as_doc(await scrape(a.url, a.render, client, browser))
                except Exception as e:
                    log(f"FAILED {a.url}: {e}")
                    sys.exit(1)
                if a.out:
                    with open(a.out, "w", encoding="utf-8") as f:
                        f.write(doc)
                    print(f"saved {a.out} ({len(doc)} chars)")
                else:
                    print(doc)

            elif a.cmd == "crawl":
                pages, failed = await crawl(a.url, a.max_pages, a.prefix, delay,
                                            a.render, client, browser, focus)
                n = save_pages(pages, failed, a.out_dir)
                extra = f", {len(failed)} failed (see failed.json)" if failed else ""
                print(f"saved {n} pages to {a.out_dir}/{extra}")

            else:  # batch
                with open(a.sites_file, encoding="utf-8") as f:
                    sites = [l.strip() for l in f
                             if l.strip() and not l.strip().startswith("#")]
                summary = []
                for url in sites:
                    if not url.startswith("http"):
                        url = "https://" + url
                    name = host(urlparse(url).netloc)
                    log(f"\n=== {name} ===")
                    pages, failed = await crawl(url, a.max_pages, None, delay,
                                                a.render, client, browser, focus)
                    n = save_pages(pages, failed, os.path.join(a.out_dir, name))
                    summary.append({"site": name, "start_url": url,
                                    "pages": n, "failed": len(failed)})
                os.makedirs(a.out_dir, exist_ok=True)
                with open(os.path.join(a.out_dir, "summary.json"), "w", encoding="utf-8") as f:
                    json.dump(summary, f, indent=2)
                for row in summary:
                    print(f"{row['site']}: {row['pages']} pages, {row['failed']} failed")
                print(f"saved to {a.out_dir}/ (summary.json, plus index.json per site)")
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
