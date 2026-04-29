"""
Post Extractor 3000 — Instagram Profile Scraper
Uses Playwright network interception to extract posts without DOM scraping.

Connects to your running Chrome via CDP (remote debugging).
No need to close Chrome.
"""

import json
import os
import re
import sys
import time
import random
import subprocess
import socket
from pathlib import Path
from datetime import datetime

import requests
from playwright.sync_api import sync_playwright, Response

# ─── Configuration ──────────────────────────────────────────────────────────────

TARGET_PROFILE = "https://www.instagram.com/virginmusicbrasil/"
MAX_POSTS = 0  # 0 = unlimited
MAX_SCROLLS = 500  # Safety limit to prevent infinite loops
SCROLL_DELAY_MIN = 2
SCROLL_DELAY_MAX = 5
STOP_DATE = "2025-12-16"  # Stop when posts are older than this date (YYYY-MM-DD), or "" to disable
OUTPUT_DIR = Path(__file__).parent / "ig_archive"
CDP_PORT = 9222

# ─── State ──────────────────────────────────────────────────────────────────────

processed_shortcodes = set()
extracted_posts = []
scroll_count = 0
no_new_posts_count = 0

# ─── Helpers ────────────────────────────────────────────────────────────────────

def log(msg, level="info"):
    timestamp = datetime.now().strftime("%H:%M:%S")
    icons = {"info": "→", "ok": "✓", "warn": "!", "err": "✗", "dl": "↓"}
    icon = icons.get(level, "•")
    print(f"[{timestamp}] {icon} {msg}")


def sanitize_filename(name, max_length=100):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', name)
    name = name.strip().strip('.')
    if len(name) > max_length:
        name = name[:max_length]
    return name


def download_file(url, filepath, retries=3):
    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=30, stream=True)
            resp.raise_for_status()
            with open(filepath, 'wb') as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
            return True
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2)
            else:
                log(f"Failed to download {url}: {e}", "err")
                return False
    return False


def is_port_open(port):
    """Check if a port is listening."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def launch_chrome_with_debugging():
    """Launch Chrome with remote debugging enabled."""
    chrome_paths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]

    for chrome_path in chrome_paths:
        if os.path.exists(chrome_path):
            log(f"Launching Chrome with remote debugging on port {CDP_PORT}...", "info")
            subprocess.Popen([
                chrome_path,
                f"--remote-debugging-port={CDP_PORT}",
                "--no-first-run",
                "--no-default-browser-check",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(3)
            return True

    return False

# ─── Post Extraction ────────────────────────────────────────────────────────────

def extract_post_from_graphql(data):
    """Extract post data from Instagram GraphQL response."""
    posts = []

    def walk(obj, path=""):
        if isinstance(obj, dict):
            if "shortcode" in obj and ("image_versions2" in obj or "video_versions" in obj or "display_url" in obj):
                posts.append(parse_media_node(obj))
            elif "node" in obj and isinstance(obj["node"], dict):
                walk(obj["node"], f"{path}.node")
            else:
                for k, v in obj.items():
                    walk(v, f"{path}.{k}")
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                walk(item, f"{path}[{i}]")

    walk(data)
    return posts


def parse_media_node(node):
    """Parse a media node into a structured post dict."""
    shortcode = node.get("shortcode", node.get("code", ""))
    post_id = node.get("pk", node.get("id", shortcode))

    # Caption
    caption = ""
    caption_obj = node.get("edge_media_to_caption", {})
    if "edges" in caption_obj and caption_obj["edges"]:
        caption = caption_obj["edges"][0].get("node", {}).get("text", "")
    elif "caption" in node:
        if isinstance(node["caption"], dict):
            caption = node["caption"].get("text", "")
        elif isinstance(node["caption"], str):
            caption = node["caption"]

    # Image URL
    image_url = ""
    if "image_versions2" in node and "candidates" in node["image_versions2"]:
        candidates = node["image_versions2"]["candidates"]
        if candidates:
            image_url = candidates[0].get("url", "")
    elif "display_url" in node:
        image_url = node["display_url"]
    elif "thumbnail_src" in node:
        image_url = node["thumbnail_src"]

    # Video URL
    video_url = ""
    if "video_versions" in node and node["video_versions"]:
        video_url = node["video_versions"][0].get("url", "")
    elif "video_url" in node:
        video_url = node["video_url"]

    # Timestamp
    taken_at = node.get("taken_at", 0)

    # Media type: 1=image, 2=video, 8=carousel
    media_type = node.get("media_type", 1)

    return {
        "shortcode": shortcode,
        "post_id": str(post_id),
        "caption": caption,
        "image_url": image_url,
        "video_url": video_url,
        "taken_at": taken_at,
        "media_type": media_type,
        "date": datetime.fromtimestamp(taken_at).strftime("%Y-%m-%d") if taken_at else "unknown",
    }


def extract_from_timeline_feed(data):
    """Extract posts from timeline/feed API responses."""
    posts = []

    def find_items(obj):
        if isinstance(obj, dict):
            if "items" in obj and isinstance(obj["items"], list):
                for item in obj["items"]:
                    if isinstance(item, dict) and "shortcode" in item:
                        posts.append(parse_media_node(item))
            if "media" in obj and isinstance(obj["media"], dict) and "shortcode" in obj["media"]:
                posts.append(parse_media_node(obj["media"]))
            for k, v in obj.items():
                find_items(v)
        elif isinstance(obj, list):
            for item in obj:
                find_items(item)

    find_items(data)
    return posts

# ─── Network Response Handler ───────────────────────────────────────────────────

def handle_response(response: Response):
    """Process network responses looking for Instagram API data."""
    global extracted_posts

    url = response.url

    if not any(endpoint in url for endpoint in [
        "/api/v1/feed/",
        "/graphql/query",
        "/api/graphql",
    ]):
        return

    content_type = response.headers.get("content-type", "")
    if "json" not in content_type and "text" not in content_type:
        return

    try:
        data = response.json()
    except Exception:
        return

    new_posts = extract_post_from_graphql(data)
    if not new_posts:
        new_posts = extract_from_timeline_feed(data)

    for post in new_posts:
        if post["shortcode"] and post["shortcode"] not in processed_shortcodes:
            processed_shortcodes.add(post["shortcode"])
            extracted_posts.append(post)
            log(f"Scraped post: {post['shortcode']} ({post['date']})", "ok")

# ─── Save Post ──────────────────────────────────────────────────────────────────

def save_post(post):
    """Download media and save caption for a post."""
    shortcode = post["shortcode"]
    if not shortcode:
        return

    post_dir = OUTPUT_DIR / f"post_{sanitize_filename(shortcode)}"
    post_dir.mkdir(parents=True, exist_ok=True)

    prefix = f"post_{sanitize_filename(shortcode)}"

    # Save caption
    caption_file = post_dir / f"{prefix}_caption.txt"
    if post["caption"]:
        with open(caption_file, "w", encoding="utf-8") as f:
            f.write(post["caption"])
        log(f"Saved caption for {shortcode}", "ok")

    # Download image
    if post["image_url"]:
        image_file = post_dir / f"{prefix}_thumbnail.jpg"
        if not image_file.exists():
            log(f"Downloading image for {shortcode}...", "dl")
            if download_file(post["image_url"], image_file):
                log(f"Saved image: {image_file.name}", "ok")
            else:
                log(f"Failed to download image for {shortcode}", "err")
        else:
            log(f"Image already exists: {image_file.name}", "info")

    # Download video
    if post["video_url"]:
        video_file = post_dir / f"{prefix}.mp4"
        if not video_file.exists():
            log(f"Downloading video for {shortcode}...", "dl")
            if download_file(post["video_url"], video_file):
                log(f"Saved video: {video_file.name}", "ok")
            else:
                log(f"Failed to download video for {shortcode}", "err")
        else:
            log(f"Video already exists: {video_file.name}", "info")

    # Save metadata
    meta_file = post_dir / f"{prefix}_meta.json"
    meta = {
        "shortcode": shortcode,
        "post_id": post["post_id"],
        "date": post["date"],
        "media_type": post["media_type"],
        "has_video": bool(post["video_url"]),
        "has_image": bool(post["image_url"]),
        "caption_length": len(post["caption"]),
    }
    with open(meta_file, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

# ─── Scrolling ──────────────────────────────────────────────────────────────────

def scroll_page(page):
    """Scroll down with human-like delay."""
    global scroll_count, no_new_posts_count

    prev_count = len(processed_shortcodes)

    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    delay = random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX)
    time.sleep(delay)

    scroll_count += 1
    new_count = len(processed_shortcodes)

    if new_count == prev_count:
        no_new_posts_count += 1
    else:
        no_new_posts_count = 0

    return new_count - prev_count

# ─── Main ───────────────────────────────────────────────────────────────────────

def main():
    global scroll_count, no_new_posts_count

    profile_name = TARGET_PROFILE.rstrip('/').split('/')[-1]
    log(f"Starting Post Extractor 3000")
    log(f"Target: {profile_name}")
    log(f"Output: {OUTPUT_DIR}")
    print()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        # Check if Chrome debugging port is available
        if is_port_open(CDP_PORT):
            log(f"Connecting to Chrome on port {CDP_PORT}...", "info")
            browser = p.chromium.connect_over_cdp(f"http://localhost:{CDP_PORT}")
        else:
            # Try to launch Chrome with debugging
            if launch_chrome_with_debugging() and is_port_open(CDP_PORT):
                log(f"Connected to newly launched Chrome on port {CDP_PORT}", "ok")
                browser = p.chromium.connect_over_cdp(f"http://localhost:{CDP_PORT}")
            else:
                log("Could not connect to Chrome.", "err")
                log("", "info")
                log("To fix this, open Chrome with remote debugging enabled:", "info")
                log("", "info")
                log("  Option 1: Run this command in Terminal:", "info")
                log('  open -a "Google Chrome" --args --remote-debugging-port=9222', "info")
                log("", "info")
                log("  Option 2: Quit Chrome completely, then run this script again.", "info")
                log("  The script will launch Chrome with debugging enabled.", "info")
                sys.exit(1)

        # Get or create a page
        contexts = browser.contexts
        if contexts and contexts[0].pages:
            page = contexts[0].pages[0]
            log("Using existing Chrome tab", "info")
        else:
            context = browser.new_context()
            page = context.new_page()
            log("Opened new tab", "info")

        # Set up network response listener
        page.on("response", handle_response)

        # Navigate to profile
        log(f"Navigating to {TARGET_PROFILE}", "info")
        page.goto(TARGET_PROFILE, wait_until="networkidle", timeout=30000)
        time.sleep(3)

        log("Profile loaded. Starting scroll & extract...", "info")
        print()

        # Scroll and extract
        consecutive_no_new = 0
        stop_date = datetime.strptime(STOP_DATE, "%Y-%m-%d") if STOP_DATE else None

        while scroll_count < MAX_SCROLLS:
            prev_count = len(extracted_posts)
            new_posts = scroll_page(page)

            if new_posts > 0:
                consecutive_no_new = 0
                log(f"Found {new_posts} new posts. Total: {len(processed_shortcodes)}", "ok")

                # Check if we've reached posts older than stop date
                if stop_date:
                    for post in extracted_posts[prev_count:]:
                        if post["taken_at"] > 0:
                            post_date = datetime.fromtimestamp(post["taken_at"])
                            if post_date < stop_date:
                                log(f"Reached stop date ({STOP_DATE}). Post {post['shortcode']} is from {post['date']}", "warn")
                                break
                    else:
                        # No posts older than stop date found, continue
                        pass
                    # Check all extracted posts for stop date
                    oldest_reached = False
                    for post in extracted_posts:
                        if post["taken_at"] > 0:
                            post_date = datetime.fromtimestamp(post["taken_at"])
                            if post_date < stop_date:
                                oldest_reached = True
                                break
                    if oldest_reached:
                        log(f"Stopping: reached posts older than {STOP_DATE}", "warn")
                        break
            else:
                consecutive_no_new += 1

            if MAX_POSTS > 0 and len(processed_shortcodes) >= MAX_POSTS:
                log(f"Reached max posts limit ({MAX_POSTS})", "warn")
                break

            if consecutive_no_new >= 10:
                log("No new posts found after 10 scrolls. Done.", "warn")
                break

            at_bottom = page.evaluate("""
                () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 100
            """)
            if at_bottom and consecutive_no_new >= 2:
                log("Reached bottom of page.", "warn")
                time.sleep(5)
                at_bottom = page.evaluate("""
                    () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 100
                """)
                if at_bottom:
                    break

        print()
        log(f"Scrolling complete. {len(extracted_posts)} posts extracted.", "ok")
        print()

        # Disconnect from browser (don't close user's Chrome)
        browser.close()

        # Download all media
        log("Starting downloads...", "info")
        print()

        for i, post in enumerate(extracted_posts, 1):
            log(f"[{i}/{len(extracted_posts)}] Processing {post['shortcode']}...", "info")
            save_post(post)

        print()
        log(f"Done! {len(extracted_posts)} posts saved to {OUTPUT_DIR}", "ok")
        print()

        # Summary
        video_count = sum(1 for p in extracted_posts if p["video_url"])
        image_count = sum(1 for p in extracted_posts if p["image_url"])
        caption_count = sum(1 for p in extracted_posts if p["caption"])

        print("=" * 50)
        print(f"  Summary")
        print("=" * 50)
        print(f"  Total posts:   {len(extracted_posts)}")
        print(f"  With video:    {video_count}")
        print(f"  With image:    {image_count}")
        print(f"  With caption:  {caption_count}")
        print(f"  Output dir:    {OUTPUT_DIR}")
        print("=" * 50)


if __name__ == "__main__":
    main()
