# Post Extractor 3000 — Project Log

---

## How to Run

**First time setup:**
```bash
cd post-extractor-3000
pip install -r requirements.txt
```

**1. Install Tampermonkey extension in Chrome:**
https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo

**2. Add the script to Tampermonkey:**
- Open Tampermonkey dashboard
- Click "+" to create new script
- Paste contents of `tampermonkey.js`
- Save (Ctrl+S)

**3. Start the local server:**
```bash
cd post-extractor-3000
python3 server.py
```

**4. Go to Instagram and click the ⛏ button (bottom right)**
- Set stop date if needed
- Click "Start Extracting"
- Script auto-scrolls and captures posts

---

## Architecture

```
post-extractor-3000/
├── tampermonkey.js       # Browser script (add to Tampermonkey)
├── server.py             # Local server (port 5003)
├── requirements.txt
├── .gitignore
├── project-log.md
├── data/
│   └── posts.json        # Extracted post data
└── ig_archive/           # Downloaded media (gitignored)
    └── post_[shortcode]/
        ├── post_[shortcode]_caption.txt
        ├── post_[shortcode]_thumbnail.jpg
        ├── post_[shortcode].mp4        (if video)
        └── post_[shortcode]_meta.json
```

**Ports:**
- Server: `localhost:5003`

---

## How It Works

1. **Tampermonkey script** runs on instagram.com
2. Intercepts XHR and fetch requests to Instagram's API
3. Extracts post data (shortcode, caption, image, video URLs)
4. Sends data to local server at `localhost:5003`
5. **Server** receives data, downloads media, saves to folders

**Why this approach:**
- No need to close Chrome
- Uses your existing Instagram login
- Works on any Instagram page (profile, feed, etc.)
- No remote debugging needed

---

## Changelog

**2026-04-28 — Tampermonkey Rewrite**
- Replaced Playwright/CDP approach with Tampermonkey script
- Script intercepts API responses directly in browser
- Local Flask server receives and downloads media
- Added UI panel with start/stop and stop date

**2026-04-28 — Initial Creation**
- Created Playwright-based scraper (replaced)

---

## Features

- API interception (XHR + fetch hooks)
- Stop date support (stops at posts older than date)
- Auto-scroll with random 2-5s delays
- Duplicate prevention
- Download images, videos, captions
- ZIP download of all clips
- Floating UI panel on Instagram

---

## Dependencies

- **Python:** flask, flask-cors, requests
- **Browser:** Tampermonkey extension (Chrome)

---

## Configuration

Edit top of `tampermonkey.js`:
- `API_SERVER` — Server URL (default: `http://localhost:5003`)
- `stopDate` — Set via UI or hardcoded

Edit top of `server.py`:
- `PORT` — Server port (default: `5003`)

---

## Troubleshooting

- **"Failed to send"** — Make sure server.py is running
- **No posts found** — Make sure you're on a profile page and scrolling
- **Duplicates** — Clear `data/posts.json` to reset
