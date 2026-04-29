"""
Post Extractor 3000 — Local Server
Receives post data from Tampermonkey script and downloads media.
"""

import json
import os
import re
import time
import subprocess
from pathlib import Path
from datetime import datetime

import requests
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

# ─── Configuration ──────────────────────────────────────────────────────────────

OUTPUT_DIR = Path(__file__).parent / "ig_archive"
DATA_DIR = Path(__file__).parent / "data"
POSTS_FILE = DATA_DIR / "posts.json"
PORT = 5003

# ─── Setup ──────────────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app)

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)


def load_posts():
    if POSTS_FILE.exists():
        with open(POSTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_posts(posts):
    with open(POSTS_FILE, "w", encoding="utf-8") as f:
        json.dump(posts, f, indent=2, ensure_ascii=False)


def sanitize_filename(name, max_length=100):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', name)
    name = name.strip().strip('.')
    if len(name) > max_length:
        name = name[:max_length]
    return name


def download_file(url, filepath, retries=3):
    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=30, stream=True, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            })
            resp.raise_for_status()
            with open(filepath, 'wb') as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
            return True
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2)
            else:
                print(f"  ✗ Failed to download: {e}")
                return False
    return False


def fetch_post_info(shortcode):
    """Fetch post info from Instagram embed endpoint."""
    try:
        url = f"https://www.instagram.com/p/{shortcode}/embed/"
        resp = requests.get(url, timeout=10, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        })

        if resp.status_code != 200:
            print(f"  ✗ Embed returned {resp.status_code} for {shortcode}")
            return None

        html = resp.text

        # Extract image URL - look for EmbeddedMediaImage class
        image_url = ""
        img_match = re.search(r'class="EmbeddedMediaImage"[^>]*\bsrc="([^"]+)"', html)
        if img_match:
            image_url = img_match.group(1).replace("&amp;", "&")
        else:
            # Fallback: look for any instagram CDN image that's not a profile pic
            all_imgs = re.findall(r'src="(https://[^"]*\.fbcdn\.net[^"]*\.jpg[^"]*)"', html)
            for img in all_imgs:
                if 's150x150' not in img and 'profile' not in img:
                    image_url = img.replace("&amp;", "&")
                    break

        # Try to detect video
        video_url = ""
        video_match = re.search(r'"video_url":"([^"]+)"', html)
        if video_match:
            video_url = video_match.group(1).replace("\\u0026", "&")
        else:
            video_match = re.search(r'video_versions.*?"url":"([^"]+)"', html)
            if video_match:
                video_url = video_match.group(1).replace("\\u0026", "&")

        # Caption is not available in embed page for most posts
        caption = ""

        print(f"  → {shortcode}: img={'yes' if image_url else 'no'}, vid={'yes' if video_url else 'no'}")

        return {
            "image_url": image_url,
            "video_url": video_url,
            "caption": caption
        }
    except Exception as e:
        print(f"  ✗ Failed to fetch info for {shortcode}: {e}")
        return None


def save_post(post):
    """Download media and save files for a post."""
    shortcode = post.get("shortcode", "")
    if not shortcode:
        return

    safe_shortcode = sanitize_filename(shortcode)
    post_dir = OUTPUT_DIR / f"post_{safe_shortcode}"
    post_dir.mkdir(parents=True, exist_ok=True)

    prefix = f"post_{safe_shortcode}"

    # Save caption
    if post.get("caption"):
        caption_file = post_dir / f"{prefix}_caption.txt"
        with open(caption_file, "w", encoding="utf-8") as f:
            f.write(post["caption"])

    # Download image
    if post.get("image_url"):
        image_file = post_dir / f"{prefix}_thumbnail.jpg"
        if not image_file.exists():
            print(f"  ↓ Image: {shortcode}")
            download_file(post["image_url"], image_file)

    # Download video
    if post.get("video_url"):
        video_file = post_dir / f"{prefix}.mp4"
        if not video_file.exists():
            print(f"  ↓ Video: {shortcode}")
            download_file(post["video_url"], video_file)

    # Save metadata
    meta_file = post_dir / f"{prefix}_meta.json"
    meta = {
        "shortcode": shortcode,
        "post_id": post.get("post_id", ""),
        "date": post.get("date", "unknown"),
        "media_type": post.get("media_type", 1),
        "has_video": bool(post.get("video_url")),
        "has_image": bool(post.get("image_url")),
        "caption_length": len(post.get("caption", "")),
    }
    with open(meta_file, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)


# ─── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/api/posts", methods=["POST"])
def receive_post():
    """Receive a full post from the Tampermonkey script."""
    data = request.json
    if not data or not data.get("shortcode"):
        return jsonify({"error": "Invalid data"}), 400

    shortcode = data["shortcode"]

    # Check for duplicates
    posts = load_posts()
    if any(p["shortcode"] == shortcode for p in posts):
        return jsonify({"status": "duplicate", "shortcode": shortcode})

    # Add to list
    posts.append(data)
    save_posts(posts)

    # Download media
    print(f"✓ {shortcode} ({data.get('date', '?')})")
    save_post(data)

    return jsonify({"status": "ok", "shortcode": shortcode, "total": len(posts)})


@app.route("/api/shortcode", methods=["POST"])
def receive_shortcode():
    """Receive just a shortcode, fetch details from Instagram."""
    data = request.json
    if not data or not data.get("shortcode"):
        return jsonify({"error": "Invalid data"}), 400

    shortcode = data["shortcode"]
    dom_image_url = data.get("image_url", "")
    is_video = data.get("is_video", False)

    # Check for duplicates
    posts = load_posts()
    if any(p["shortcode"] == shortcode for p in posts):
        return jsonify({"status": "duplicate", "shortcode": shortcode})

    # Try to fetch more info
    info = fetch_post_info(shortcode)

    post = {
        "shortcode": shortcode,
        "post_id": shortcode,
        "caption": info.get("caption", "") if info else "",
        "image_url": (info.get("image_url", "") if info else "") or dom_image_url,
        "video_url": info.get("video_url", "") if info else "",
        "taken_at": 0,
        "media_type": 2 if is_video else 1,
        "date": "unknown"
    }

    # Add to list
    posts.append(post)
    save_posts(posts)

    # Download media
    print(f"✓ {shortcode}")
    save_post(post)

    return jsonify({"status": "ok", "shortcode": shortcode, "total": len(posts)})


@app.route("/api/full", methods=["POST"])
def receive_full():
    """Receive full post data from Tampermonkey (with caption, video, etc)."""
    data = request.json
    if not data or not data.get("shortcode"):
        return jsonify({"error": "Invalid data"}), 400

    shortcode = data["shortcode"]

    posts = load_posts()
    if any(p["shortcode"] == shortcode for p in posts):
        return jsonify({"status": "duplicate", "shortcode": shortcode})

    post = {
        "shortcode": shortcode,
        "post_id": shortcode,
        "caption": data.get("caption", ""),
        "image_url": data.get("image_url", ""),
        "video_url": data.get("video_url", ""),
        "taken_at": 0,
        "media_type": 2 if data.get("video_url") else 1,
        "date": "unknown"
    }

    posts.append(post)
    save_posts(posts)

    has_caption = "✓" if post["caption"] else "✗"
    has_video = "✓" if post["video_url"] else "✗"
    print(f"✓ {shortcode} caption={has_caption} video={has_video}")
    save_post(post)

    return jsonify({"status": "ok", "shortcode": shortcode, "total": len(posts)})


@app.route("/api/posts", methods=["GET"])
def get_posts():
    """Get all extracted posts."""
    return jsonify(load_posts())


@app.route("/api/status", methods=["GET"])
def status():
    """Server status."""
    posts = load_posts()
    return jsonify({
        "status": "ok",
        "total_posts": len(posts),
        "output_dir": str(OUTPUT_DIR)
    })


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "post-extractor-3000"})


@app.route("/api/links", methods=["POST"])
def save_links():
    """Save post links to a text file."""
    data = request.json
    if not data or not data.get("links"):
        return jsonify({"error": "No links provided"}), 400

    links_file = Path(__file__).parent / "post_links.txt"
    with open(links_file, "w", encoding="utf-8") as f:
        f.write("\n".join(data["links"]))

    print(f"✓ Saved {len(data['links'])} links to post_links.txt")
    return jsonify({"status": "ok", "count": len(data["links"])})


# ─── Main ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 50)
    print("  Post Extractor 3000 — Server")
    print(f"  http://localhost:{PORT}")
    print("=" * 50)
    app.run(host="0.0.0.0", port=PORT, debug=False)
