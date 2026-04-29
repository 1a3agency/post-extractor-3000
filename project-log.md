# Post Extractor 3000 — Project Log

---

## How to Run

**First time setup:**
```bash
cd post-extractor-3000
pip install -r requirements.txt
playwright install chromium
```

**Run the scraper:**
```bash
cd post-extractor-3000
python3 scraper.py
```

**Before running:**
- Close all Chrome windows (the script launches Chrome with your profile)
- Edit `TARGET_PROFILE` in `scraper.py` to set the Instagram URL

---

## What It Does

Scrapes an Instagram profile by intercepting network requests (not DOM scraping).

1. Launches Chrome with your existing login session
2. Navigates to the target Instagram profile
3. Scrolls and intercepts GraphQL/API responses
4. Extracts post data (shortcode, caption, image URL, video URL)
5. Downloads media into organized folders

**Output structure:**
```
ig_archive/
├── post_ABC123/
│   ├── post_ABC123_caption.txt
│   ├── post_ABC123_thumbnail.jpg
│   ├── post_ABC123.mp4          (if video)
│   └── post_ABC123_meta.json
├── post_XYZ789/
│   └── ...
```

---

## Configuration

Edit these values at the top of `scraper.py`:

| Variable | Default | Description |
|---|---|---|
| `TARGET_PROFILE` | `https://www.instagram.com/antigravityco/` | Profile URL to scrape |
| `MAX_POSTS` | `0` | Max posts to extract (0 = unlimited) |
| `MAX_SCROLLS` | `100` | Max scroll attempts (safety limit) |
| `SCROLL_DELAY_MIN` | `2` | Min delay between scrolls (seconds) |
| `SCROLL_DELAY_MAX` | `5` | Max delay between scrolls (seconds) |

---

## Changelog

**2026-04-28 — Initial Creation**
- Created scraper.py with Playwright network interception
- No DOM scraping — relies on intercepting GraphQL/API responses
- Human-like scrolling with random delays
- Downloads images, videos, and captions
- Organized output in `post_[shortcode]` folders

---

## Architecture

```
post-extractor-3000/
├── scraper.py           # Main script
├── requirements.txt     # Python dependencies
├── .gitignore
├── project-log.md       # This file
└── ig_archive/          # Downloaded posts (gitignored)
```

---

## How It Works

1. **Network Interception** — Listens for Instagram's API responses instead of parsing HTML
2. **GraphQL Parsing** — Extracts shortcode, caption, image URLs, video URLs from JSON
3. **Persistent Context** — Uses Chrome's user data directory for existing login session
4. **Duplicate Prevention** — Tracks processed shortcodes in a set
5. **Error Handling** — Retries failed downloads, skips broken links

---

## Dependencies

- **Python:** playwright, requests
- **Browser:** Chromium (installed via `playwright install chromium`)

---

## Troubleshooting

- **"Chrome is already running"** — Close all Chrome windows before running
- **No posts found** — Make sure you're logged into Instagram in Chrome
- **Downloads fail** — Check your internet connection; script retries 3 times
