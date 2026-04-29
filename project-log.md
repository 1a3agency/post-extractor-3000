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
- Close all Chrome windows (the script launches Chrome with your profile)
- Edit `TARGET_PROFILE` at the top of `scraper.py`

---

## Changelog

**2026-04-28 — Initial Creation**
- Created scraper.py with Playwright network interception
- No DOM scraping — intercepts GraphQL/API responses instead
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
- `MAX_POSTS` — Limit posts (0 = unlimited)
- `MAX_SCROLLS` — Max scroll attempts (default 100)
- `SCROLL_DELAY_MIN/MAX` — Delay between scrolls (2-5s)

---

## Features

- Network interception (no DOM scraping, survives class changes)
- Uses existing Chrome login session (persistent context)
- Extracts shortcode, caption, image URL, video URL
- Downloads media to organized folder structure
- Duplicate prevention via processed shortcodes set
- Error handling with 3x retry on failed downloads

---

## Technical Notes

- Intercepts `/api/v1/feed/` and `/graphql/query` responses
- Parses Instagram's internal JSON structure for media nodes
- Walks nested objects to find `shortcode` + `image_versions2` or `video_versions`
- Chrome user data: `~/Library/Application Support/Google/Chrome`

---

## Dependencies

- **Python:** playwright, requests
- **Browser:** Chromium (via `playwright install chromium`)

---

## Troubleshooting

- **"Chrome is already running"** — Close all Chrome windows before running
- **No posts found** — Make sure you're logged into Instagram in Chrome
- **Downloads fail** — Check internet connection; script retries 3 times
