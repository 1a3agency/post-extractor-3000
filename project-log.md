# Post Extractor 3000 — Project Log

---

## How to Run

```bash
cd post-extractor-3000
python3 scraper.py
```

**First time setup:**
```bash
cd post-extractor-3000
pip install -r requirements.txt
playwright install chromium
```

**Before running:**
- Edit config at top of `scraper.py`:
  - `TARGET_PROFILE` — Instagram URL to scrape
  - `STOP_DATE` — Stop when posts are older than this date (YYYY-MM-DD), or "" to disable
- Make sure Chrome is open and logged into Instagram

---

## Changelog

**2026-04-28 — CDP Connection (no need to close Chrome)**
- Switched from `launch_persistent_context` to `connect_over_cdp`
- Connects to running Chrome via remote debugging port 9222
- If Chrome is closed, script launches it with debugging enabled
- No need to close Chrome before running

**2026-04-28 — Initial Creation**
- Created scraper.py with Playwright network interception
- No DOM scraping — intercepts GraphQL/API responses
- Human-like scrolling with random 2-5s delays
- Downloads images, videos, and captions
- Organized output in `post_[shortcode]` folders

---

## Architecture

```
post-extractor-3000/
├── scraper.py           # Main script (config at top)
├── requirements.txt     # Python dependencies
├── .gitignore
├── project-log.md       # This file
└── ig_archive/          # Downloaded posts (gitignored)
    └── post_[shortcode]/
        ├── post_[shortcode]_caption.txt
        ├── post_[shortcode]_thumbnail.jpg
        ├── post_[shortcode].mp4        (if video)
        └── post_[shortcode]_meta.json
```

**Config (top of scraper.py):**
- `TARGET_PROFILE` — Instagram URL to scrape
- `STOP_DATE` — Stop when posts are older than this date (YYYY-MM-DD), or "" to disable
- `MAX_POSTS` — Limit posts (0 = unlimited)
- `MAX_SCROLLS` — Max scroll attempts (default 500)
- `SCROLL_DELAY_MIN/MAX` — Delay between scrolls (2-5s)
- `CDP_PORT` — Chrome debugging port (default 9222)

---

## How It Connects to Chrome

1. Checks if port 9222 is open (Chrome with debugging)
2. If yes: connects to existing Chrome via CDP
3. If no: launches Chrome with `--remote-debugging-port=9222`
4. Uses existing Instagram session (no login needed)

---

## Features

- Network interception (no DOM scraping, survives class changes)
- Connects to running Chrome (no need to close it)
- Extracts shortcode, caption, image URL, video URL
- Downloads media to organized folder structure
- Duplicate prevention via processed shortcodes set
- Error handling with 3x retry on failed downloads

---

## Technical Notes

- Intercepts `/api/v1/feed/` and `/graphql/query` responses
- Parses Instagram's internal JSON structure for media nodes
- Walks nested objects to find `shortcode` + `image_versions2` or `video_versions`
- Uses `playwright.chromium.connect_over_cdp()` instead of `launch_persistent_context()`

---

## Dependencies

- **Python:** playwright, requests
- **Browser:** Chromium (via `playwright install chromium`) or Chrome

---

## Troubleshooting

- **"Could not connect to Chrome"** — Open Chrome with: `open -a "Google Chrome" --args --remote-debugging-port=9222`
- **No posts found** — Make sure you're logged into Instagram in Chrome
- **Downloads fail** — Check internet connection; script retries 3 times
