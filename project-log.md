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
- Enter number of posts to grab
- Click Start
- Links are saved to `post_links.txt` when done

---

## Architecture

```
post-extractor-3000/
├── tampermonkey.js       # Browser script (add to Tampermonkey)
├── server.py             # Local server (port 5003)
├── requirements.txt
├── .gitignore
├── project-log.md
├── post_links.txt        # Saved post links
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
2. Collects post links from the profile grid
3. **Clicks each post** to open the modal
4. Extracts caption, image, video from the modal DOM
5. Closes modal, moves to next post
6. Sends data to local server at `localhost:5003`
7. **Server** downloads media and saves to folders
8. On stop, saves all post links to `post_links.txt`

**Why this approach:**
- No need to close Chrome
- Uses your existing Instagram login
- Extracts captions and videos reliably
- Clicks each post individually (slower but accurate)

---

## Changelog

**2026-04-29 — v13.0: Click-based extraction**
- Clicks each post to open modal
- Extracts caption, image, video from modal DOM
- Grabs video thumbnail from video.poster
- Slower but reliable

**2026-04-29 — v10.0: Links + Captions + Videos**
- Fetches each post page with browser session
- Extracts captions from logged-in pages
- Detects and downloads videos
- Saves post links to `post_links.txt`

**2026-04-29 — v8.0: Count-based extraction**
- Replaced date-based with count-based (how many posts)
- Simpler and more reliable

**2026-04-28 — Tampermonkey Rewrite**
- Replaced Playwright/CDP approach with Tampermonkey script
- Local Flask server receives and downloads media

**2026-04-28 — Initial Creation**
- Created Playwright-based scraper (replaced)

---

## Features

- Count-based extraction (enter how many posts)
- Fetches full post details with your login
- Downloads images, videos, captions
- Saves post links to `post_links.txt`
- Auto-scroll with random delays
- Duplicate prevention
- Floating UI panel on Instagram

---

## Dependencies

- **Python:** flask, flask-cors, requests
- **Browser:** Tampermonkey extension (Chrome)

---

## Configuration

Edit top of `tampermonkey.js`:
- `API_SERVER` — Server URL (default: `http://localhost:5003`)

Edit top of `server.py`:
- `PORT` — Server port (default: `5003`)

---

## Troubleshooting

- **"Failed to send"** — Make sure server.py is running
- **No posts found** — Make sure you're on a profile page
- **No captions** — Script needs to fetch each post page (slower)
- **Duplicates** — Clear `data/posts.json` and `ig_archive/` to reset
