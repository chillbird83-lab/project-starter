#!/usr/bin/env python3
"""Lightweight Firecrawl-style scraper: URL -> clean Markdown, site crawls and multi-site batches."""
import argparse, asyncio, heapq, itertools, json, os, re, sys
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
RETRY_IN_BROWSER = {403, 429, 503}  # often bot filters that a real browser gets past
FOCUS_DEFAULT = ["pricing", "price", "plans", "features", "product", "solutions",
                 "platform", "about", "customers", "case-stud", "integrations",
                 "compare", "vs", "blog", "careers"]


def log(msg):
    print(msg, file=sys.stderr)


def host(netloc):
    return netloc.lower().removeprefix("www.")


def page_key(url):
    """Treat /pricing and /pricing/, http and https, www and non-www as one page."""
    p = urlparse(url)
    return host(p.netloc), p.path.rstrip("/") or "/", p.query


def short(e):
    text = str(e).strip()
    return text.splitlines()[0] if text else type(e).__name__


class Browser:
    """Starts Chromium lazily, so static-only runs never need it."""
    def __init__(self):
        self.pw = self.browser = self.broken = None

    async def page_html(self, url):
        if self.broken:
            raise RuntimeError(self.broken)
        if self.browser is None:
            try:
                from playwright.async_api import async_playwright
                self.pw = await async_playwright().start()
                self.browser = await self.pw.chromium.launch(headless=True)
            except Exception as e:  # report once, then stop retrying
                self.broken = f"browser unavailable ({short(e)})"
                log(f"note: {self.broken}; continuing without JavaScript rendering")
                raise RuntimeError(self.broken)
        page = await self.browser.new_page(user_agent=UA)
        try:
            resp = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            if resp and resp.status >= 400:
                raise RuntimeError(f"HTTP {resp.status}")
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
        if self.pw:
            await self.pw.stop()


def words(text):
    return len(re.findall(r"[^\W\d_]{2,}", re.sub(r"\]\([^)]*\)", "]", text)))


def full_markdown(html):
    """Crude cleanup, then convert the whole main area."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "nav", "aside", "form", "svg"]):
        tag.decompose()
    for tag in soup(["header", "footer"]):  # site banner and footer, not article headers
        if not tag.find_parent(["main", "article"]):
            tag.decompose()
    main = soup.find("main") or soup.find("article") or soup.body or soup
    out = md(str(main), heading_style="ATX")
    out = re.sub(r"!\[\]\([^)]*\)", "", out)  # images without alt text
    out = re.sub(r"[ \t]+\n", "\n", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def to_markdown(html, url):
    # Main-content extraction is cleanest for articles, but it drops pricing tables,
    # feature grids and logo walls, so use the whole main area when it loses too much.
    out = trafilatura.extract(html, url=url, output_format="markdown",
                              include_links=True, include_tables=True,
                              favor_recall=True) or ""
    full = full_markdown(html)
    if len(out) > 200 and words(out) >= 0.75 * words(full):
        return out
    return max(full, out, key=words)


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
        except Exception as e:  # network error: the browser may still get through
            err = short(e)
        else:
            code = r.status_code
            if code >= 400:
                err = f"HTTP {code}"
                if BLOCK_MARKERS.search(r.text[:5000]):
                    err += " (bot protection page)"
                # 404s and the like are real errors; a browser would just render them
                if render == "never" or code not in RETRY_IN_BROWSER:
                    raise RuntimeError(err)
            elif "html" not in r.headers.get("content-type", ""):
                ctype = r.headers.get("content-type") or "unknown type"
                raise RuntimeError(f"not an HTML page ({ctype})")
            else:
                final, html = str(r.url), r.text
        if err and render == "never":
            raise RuntimeError(err)
    thin = html is None or len(to_markdown(html, final)) < 300
    if render == "always" or (render == "auto" and thin):
        try:
            final, html = await browser.page_html(url)
        except Exception as e:
            if html is None:
                raise RuntimeError(f"static fetch: {err}; browser: {short(e)}" if err
                                   else f"browser: {short(e)}")
            if not browser.broken:
                log(f"note: browser render failed ({short(e)}); using static HTML")
    markdown = to_markdown(html, final)
    if looks_blocked(html, markdown):
        raise RuntimeError("blocked by bot protection")
    return {"url": final, **meta(html), "markdown": markdown, "html": html}


def priority(path, focus_res):
    """Sort key: the earliest focus keyword in the path wins, then shallower pages.
    Keywords must start a word: 'vs' matches /acme-vs-rival, not /devs.
    Without focus keywords every page ties, so the crawl stays breadth-first."""
    if not focus_res:
        return 0, 0
    path = path.lower()
    rank = next((i for i, r in enumerate(focus_res) if r.search(path)), len(focus_res))
    return rank, path.strip("/").count("/")


async def crawl(start, max_pages, prefix, delay, render, client, browser, focus=None):
    p0 = urlparse(start)
    site = host(p0.netloc)
    rp = await load_robots(client, p0)
    focus_res = [re.compile(r"(?<![a-z0-9])" + re.escape(k)) for k in focus or []]
    order = itertools.count()  # ties keep discovery order
    queue, seen, fetched = [(-1, 0, next(order), start)], {page_key(start)}, set()
    pages, failed = [], []
    while queue and len(pages) < max_pages:
        url = heapq.heappop(queue)[-1]
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
        if page_key(page["url"]) in fetched:  # redirected to a page we already have
            await asyncio.sleep(delay)
            continue
        fetched.add(page_key(page["url"]))
        if not pages:
            p1 = urlparse(page["url"])
            if host(p1.netloc) != site:  # start URL redirected to another domain
                log(f"note: {site} redirects to {host(p1.netloc)}; crawling that instead")
                site = host(p1.netloc)
                rp = await load_robots(client, p1)
        pages.append(page)
        log(f"✓ [{len(pages)}/{max_pages}] {url}")
        for link in links(page["html"], page["url"]):
            p = urlparse(link)
            if host(p.netloc) != site or page_key(link) in seen or SKIP_EXT.search(p.path):
                continue
            if prefix and not p.path.startswith(prefix):
                continue
            seen.add(page_key(link))
            heapq.heappush(queue, (*priority(p.path, focus_res), next(order), link))
        await asyncio.sleep(delay)
    return pages, failed


def as_doc(p):
    return f"# {p['title']}\n\nSource: {p['url']}\n\n{p['markdown']}\n"


def save_pages(pages, failed, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for old in os.listdir(out_dir):  # pages from an earlier run; other files are left alone
        if re.fullmatch(r"\d{3}-.*\.md", old):
            os.remove(os.path.join(out_dir, old))
    index = []
    for i, p in enumerate(pages):
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", urlparse(p["url"]).path).strip("-") or "index"
        name = f"{i:03d}-{slug[:80]}.md"
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            f.write(as_doc(p))
        index.append({"url": p["url"], "title": p["title"],
                      "description": p["description"],
                      "chars": len(p["markdown"]), "file": name})
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
    failed_path = os.path.join(out_dir, "failed.json")
    if failed:
        with open(failed_path, "w", encoding="utf-8") as f:
            json.dump(failed, f, indent=2)
    elif os.path.exists(failed_path):
        os.remove(failed_path)  # don't leave failures from an earlier run behind
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
