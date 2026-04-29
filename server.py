"""
Post Extractor 3000 — Local Server
Receives post data from Tampermonkey script and downloads media.
"""

import json
import os
import re
import time
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
            print(f"  ↓ Downloading image for {shortcode}...")
            download_file(post["image_url"], image_file)

    # Download video
    if post.get("video_url"):
        video_file = post_dir / f"{prefix}.mp4"
        if not video_file.exists():
            print(f"  ↓ Downloading video for {shortcode}...")
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
    """Receive a post from the Tampermonkey script."""
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
    print(f"✓ Received: {shortcode} ({data.get('date', 'unknown')})")
    save_post(data)

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


@app.route("/api/download-all", methods=["GET"])
def download_all():
    """Download all clips as a zip."""
    import io
    import zipfile

    mp4_files = sorted(OUTPUT_DIR.rglob("*.mp4"))
    if not mp4_files:
        return jsonify({"error": "No clips found"}), 404

    memory_file = io.BytesIO()
    with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
        for f in mp4_files:
            zf.write(f, f.relative_to(OUTPUT_DIR))
    memory_file.seek(0)

    return send_file(
        memory_file,
        mimetype='application/zip',
        as_attachment=True,
        download_name='post-extractor-clips.zip'
    )


# ─── Main ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 50)
    print("  Post Extractor 3000 — Server")
    print(f"  Running on http://localhost:{PORT}")
    print("=" * 50)
    app.run(host="0.0.0.0", port=PORT, debug=False)
