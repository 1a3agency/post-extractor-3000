// ==UserScript==
// @name         Post Extractor 3000
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Extract Instagram posts via DOM scraping
// @match        https://www.instagram.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const API_SERVER = 'http://localhost:5003';
    const processedShortcodes = new Set();
    let isExtracting = false;
    let stopShortcode = null;
    let postCount = 0;
    let scrollInterval = null;

    function log(msg, level = 'info') {
        const styles = { info: 'color: #a855f7', ok: 'color: #22c55e', warn: 'color: #eab308', err: 'color: #ef4444' };
        console.log(`%c[PE3000] ${msg}`, styles[level] || styles.info);
    }

    // ─── Send to Server ───────────────────────────────────────────────

    function sendToServer(endpoint, data) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API_SERVER}${endpoint}`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(data),
            onload: function(resp) {
                if (resp.status === 200) {
                    postCount++;
                    updateUI();
                    log(`Saved: ${data.shortcode} (${postCount})`, 'ok');
                }
            },
            onerror: function() {
                log(`Failed: ${data.shortcode}`, 'err');
            }
        });
    }

    // ─── DOM Scraping (sorted top-to-bottom) ──────────────────────────

    function extractFromDOM() {
        // Find ALL post links, not just in main
        const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
        const results = [];
        const seen = new Set();

        links.forEach(link => {
            // More flexible regex to match shortcodes
            const match = link.href.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]{5,})/);
            if (!match || seen.has(match[1])) return;
            seen.add(match[1]);

            const shortcode = match[1];
            const rect = link.getBoundingClientRect();

            // Skip header area
            if (rect.top < -100) return;

            let imageUrl = '';
            const img = link.querySelector('img');
            if (img) imageUrl = img.src || img.dataset.src || '';

            // Check for video/carousel indicators
            const isReel = link.href.includes('/reel/') || link.href.includes('/tv/');
            const hasCarouselIcon = link.querySelector('[aria-label*="Carousel"]') ||
                                    link.querySelector('[aria-label*="carousel"]') ||
                                    link.querySelector('.coreSpriteCarousel') ||
                                    link.closest('article')?.querySelector('[aria-label*="Carousel"]');

            results.push({
                shortcode,
                image_url: imageUrl,
                is_video: isReel,
                is_carousel: !!hasCarouselIcon,
                top: rect.top + window.scrollY
            });
        });

        results.sort((a, b) => a.top - b.top);
        return results;
    }

    // ─── Process Posts (in order, stop at target) ─────────────────────

    function processPosts(posts) {
        // If stop shortcode exists, only process posts up to (and including) it
        let postsToProcess = posts;
        if (stopShortcode) {
            const stopIndex = posts.findIndex(p => p.shortcode === stopShortcode);
            if (stopIndex !== -1) {
                postsToProcess = posts.slice(0, stopIndex + 1);
            }
        }

        for (const post of postsToProcess) {
            if (processedShortcodes.has(post.shortcode)) continue;

            processedShortcodes.add(post.shortcode);
            sendToServer('/api/shortcode', {
                shortcode: post.shortcode,
                image_url: post.image_url,
                is_video: post.is_video
            });

            // Stop after saving the target post
            if (stopShortcode && post.shortcode === stopShortcode) {
                log(`Reached stop post: ${stopShortcode}`, 'warn');
                isExtracting = false;
                if (scrollInterval) clearInterval(scrollInterval);
                updateButtons();
                return true;
            }
        }
        return false;
    }

    // ─── Page Data Extraction ─────────────────────────────────────────

    function extractFromPageData() {
        const posts = [];

        if (window._sharedData) {
            walkForPosts(window._sharedData, posts);
            if (posts.length > 0) return posts;
        }

        for (const key of Object.keys(window)) {
            if (key.startsWith('__additionalData') && window[key]) {
                walkForPosts(window[key], posts);
                if (posts.length > 0) return posts;
            }
        }

        document.querySelectorAll('script[type="application/json"]').forEach(script => {
            try {
                walkForPosts(JSON.parse(script.textContent), posts);
            } catch (e) {}
        });

        return posts;
    }

    function walkForPosts(obj, posts, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 25) return;

        if (obj.shortcode || obj.code) {
            const hasMedia = obj.image_versions2 || obj.video_versions || obj.display_url || obj.thumbnail_src || obj.caption;
            if (hasMedia) {
                posts.push(parseNode(obj));
                return;
            }
        }

        if (Array.isArray(obj.items)) obj.items.forEach(i => walkForPosts(i, posts, depth + 1));
        if (Array.isArray(obj.edges)) obj.edges.forEach(e => { if (e.node) walkForPosts(e.node, posts, depth + 1); });
        if (Array.isArray(obj)) obj.forEach(i => walkForPosts(i, posts, depth + 1));
        else Object.values(obj).forEach(v => { if (typeof v === 'object') walkForPosts(v, posts, depth + 1); });
    }

    function parseNode(node) {
        const shortcode = node.shortcode || node.code || '';

        let caption = '';
        if (node.edge_media_to_caption?.edges?.[0]?.node?.text) caption = node.edge_media_to_caption.edges[0].node.text;
        else if (typeof node.caption === 'string') caption = node.caption;
        else if (node.caption?.text) caption = node.caption.text;

        let imageUrl = '';
        if (node.image_versions2?.candidates?.[0]?.url) imageUrl = node.image_versions2.candidates[0].url;
        else if (node.display_url) imageUrl = node.display_url;

        let videoUrl = '';
        if (node.video_versions?.[0]?.url) videoUrl = node.video_versions[0].url;
        else if (node.video_url) videoUrl = node.video_url;

        return {
            shortcode,
            post_id: String(node.pk || node.id || shortcode),
            caption,
            image_url: imageUrl,
            video_url: videoUrl,
            taken_at: node.taken_at || 0,
            media_type: node.media_type || 1,
            date: node.taken_at ? new Date(node.taken_at * 1000).toISOString().split('T')[0] : 'unknown'
        };
    }

    // ─── UI ───────────────────────────────────────────────────────────

    function createUI() {
        const panel = document.createElement('div');
        panel.id = 'pe3000';
        panel.innerHTML = `
            <style>
                #pe3000 { position: fixed; bottom: 20px; right: 20px; z-index: 999999; font-family: -apple-system, sans-serif; font-size: 13px; }
                #pe3000-toggle { width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #8b5cf6); border: none; color: white; cursor: pointer; box-shadow: 0 4px 12px rgba(99,102,241,0.4); font-size: 20px; }
                #pe3000-card { display: none; background: #1a1a2e; border: 1px solid rgba(99,102,241,0.3); border-radius: 16px; padding: 16px; width: 280px; margin-bottom: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
                #pe3000-card.open { display: block; }
                #pe3000-card h3 { margin: 0 0 12px; color: white; font-size: 14px; font-weight: 700; }
                #pe3000-card label { color: #94a3b8; font-size: 11px; display: block; margin-bottom: 4px; }
                #pe3000-card input { width: 100%; padding: 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: #0f0f1a; color: white; font-size: 12px; margin-bottom: 10px; box-sizing: border-box; }
                #pe3000-card button { width: 100%; padding: 10px; border-radius: 10px; border: none; font-weight: 600; cursor: pointer; font-size: 13px; margin-bottom: 6px; }
                .pe3000-start { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; }
                .pe3000-stop { background: rgba(239,68,68,0.2); color: #ef4444; border: 1px solid rgba(239,68,68,0.3) !important; }
                .pe3000-stats { color: #94a3b8; font-size: 11px; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); }
                .pe3000-stats span { color: #8b5cf6; font-weight: 600; }
            </style>
            <div id="pe3000-card">
                <h3>⛏ Post Extractor 3000</h3>
                <label>Last post to grab (paste URL)</label>
                <input type="text" id="pe3000-last" placeholder="https://instagram.com/p/ABC123/">
                <button class="pe3000-start" id="pe3000-start">Start Extracting</button>
                <button class="pe3000-stop" id="pe3000-stop" style="display:none">Stop</button>
                <div class="pe3000-stats">Posts saved: <span id="pe3000-count">0</span></div>
            </div>
            <button id="pe3000-toggle">⛏</button>
        `;
        document.body.appendChild(panel);

        document.getElementById('pe3000-toggle').onclick = () => {
            document.getElementById('pe3000-card').classList.toggle('open');
        };
        document.getElementById('pe3000-start').onclick = startExtracting;
        document.getElementById('pe3000-stop').onclick = stopExtracting;
    }

    function updateUI() {
        const el = document.getElementById('pe3000-count');
        if (el) el.textContent = postCount;
    }

    function updateButtons() {
        document.getElementById('pe3000-start').style.display = isExtracting ? 'none' : 'block';
        document.getElementById('pe3000-stop').style.display = isExtracting ? 'block' : 'none';
    }

    // ─── Extract Logic ────────────────────────────────────────────────

    function startExtracting() {
        // Parse stop shortcode
        const lastUrl = document.getElementById('pe3000-last').value.trim();
        stopShortcode = null;
        if (lastUrl) {
            const match = lastUrl.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
            if (match) {
                stopShortcode = match[2];
                log(`Will stop at: ${stopShortcode}`, 'info');
            }
        }

        isExtracting = true;
        postCount = 0;
        processedShortcodes.clear();
        updateUI();
        updateButtons();
        log('Started...', 'ok');

        // First pass: extract from DOM (sorted top-to-bottom)
        const domPosts = extractFromDOM();
        log(`Found ${domPosts.length} posts on page`, 'info');
        log(`Shortcodes: ${domPosts.map(p => p.shortcode).join(', ')}`, 'debug');

        if (processPosts(domPosts)) return; // stopped

        // Auto-scroll for more posts
        scrollInterval = setInterval(() => {
            if (!isExtracting) {
                clearInterval(scrollInterval);
                return;
            }

            const newPosts = extractFromDOM();
            const unseen = newPosts.filter(p => !processedShortcodes.has(p.shortcode));

            if (unseen.length > 0) {
                log(`Found ${unseen.length} new posts`, 'info');
                if (processPosts(unseen)) return; // stopped
            }

            window.scrollTo(0, document.body.scrollHeight);
        }, 3000 + Math.random() * 2000);
    }

    function stopExtracting() {
        isExtracting = false;
        if (scrollInterval) clearInterval(scrollInterval);
        updateButtons();
        log(`Stopped. Total: ${postCount}`, 'warn');
    }

    // ─── Init ─────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }
    log('Loaded. Click ⛏ to start.', 'ok');
})();
