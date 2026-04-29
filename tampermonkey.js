// ==UserScript==
// @name         Post Extractor 3000
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Extract Instagram posts via DOM scraping and API interception
// @match        https://www.instagram.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const API_SERVER = 'http://localhost:5003';
    const processedShortcodes = new Set();
    let isExtracting = false;
    let stopDate = null;

    function log(msg, level = 'info') {
        const styles = {
            info: 'color: #a855f7',
            ok: 'color: #22c55e',
            warn: 'color: #eab308',
            err: 'color: #ef4444'
        };
        console.log(`%c[PE3000] ${msg}`, styles[level] || styles.info);
    }

    // ─── Extract from _sharedData ─────────────────────────────────────

    function extractFromSharedData() {
        const posts = [];

        // Try multiple sources
        const sources = [
            () => window._sharedData,
            () => {
                for (const key of Object.keys(window)) {
                    if (key.startsWith('__additionalData') && window[key]) {
                        return window[key];
                    }
                }
                return null;
            }
        ];

        for (const getSource of sources) {
            try {
                const data = getSource();
                if (data) {
                    walkForPosts(data, posts);
                    if (posts.length > 0) return posts;
                }
            } catch (e) {}
        }

        // Try script tags
        const scripts = document.querySelectorAll('script[type="application/json"]');
        for (const script of scripts) {
            try {
                const data = JSON.parse(script.textContent);
                walkForPosts(data, posts);
                if (posts.length > 0) return posts;
            } catch (e) {}
        }

        return posts;
    }

    function walkForPosts(obj, posts, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 25) return;

        if (obj.shortcode || obj.code) {
            const shortcode = obj.shortcode || obj.code;
            const hasMedia = obj.image_versions2 || obj.video_versions ||
                            obj.display_url || obj.thumbnail_src ||
                            obj.edge_media_to_caption || obj.caption;

            if (hasMedia) {
                posts.push(parseNode(obj));
                return;
            }
        }

        if (Array.isArray(obj.items)) {
            obj.items.forEach(item => walkForPosts(item, posts, depth + 1));
        }
        if (Array.isArray(obj.edges)) {
            obj.edges.forEach(edge => {
                if (edge.node) walkForPosts(edge.node, posts, depth + 1);
            });
        }
        if (Array.isArray(obj)) {
            obj.forEach(item => walkForPosts(item, posts, depth + 1));
        } else {
            Object.values(obj).forEach(val => {
                if (typeof val === 'object') walkForPosts(val, posts, depth + 1);
            });
        }
    }

    function parseNode(node) {
        const shortcode = node.shortcode || node.code || '';

        let caption = '';
        const captionObj = node.edge_media_to_caption;
        if (captionObj?.edges?.[0]?.node?.text) {
            caption = captionObj.edges[0].node.text;
        } else if (typeof node.caption === 'string') {
            caption = node.caption;
        } else if (node.caption?.text) {
            caption = node.caption.text;
        }

        let imageUrl = '';
        if (node.image_versions2?.candidates?.[0]?.url) {
            imageUrl = node.image_versions2.candidates[0].url;
        } else if (node.display_url) {
            imageUrl = node.display_url;
        } else if (node.thumbnail_src) {
            imageUrl = node.thumbnail_src;
        }

        let videoUrl = '';
        if (node.video_versions?.[0]?.url) {
            videoUrl = node.video_versions[0].url;
        } else if (node.video_url) {
            videoUrl = node.video_url;
        }

        const takenAt = node.taken_at || 0;

        return {
            shortcode,
            post_id: String(node.pk || node.id || shortcode),
            caption,
            image_url: imageUrl,
            video_url: videoUrl,
            taken_at: takenAt,
            media_type: node.media_type || 1,
            date: takenAt ? new Date(takenAt * 1000).toISOString().split('T')[0] : 'unknown'
        };
    }

    // ─── DOM Scraping ─────────────────────────────────────────────────

    function extractFromDOM() {
        const results = [];

        // Find post links
        const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
        const seen = new Set();

        links.forEach(link => {
            const match = link.href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
            if (match && !seen.has(match[2])) {
                seen.add(match[2]);
                const shortcode = match[2];

                // Try to get image from the link or its parent
                let imageUrl = '';
                const img = link.querySelector('img') || link.parentElement?.querySelector('img');
                if (img) {
                    imageUrl = img.src || img.dataset.src || '';
                }

                // Check if it's a video (look for video indicator)
                let isVideo = false;
                const svg = link.querySelector('svg');
                if (svg) {
                    const ariaLabel = svg.getAttribute('aria-label') || '';
                    if (ariaLabel.toLowerCase().includes('reel') || ariaLabel.toLowerCase().includes('video')) {
                        isVideo = true;
                    }
                }
                if (link.href.includes('/reel/')) isVideo = true;

                results.push({
                    shortcode,
                    image_url: imageUrl,
                    is_video: isVideo
                });
            }
        });

        return results;
    }

    // ─── Network Interception ─────────────────────────────────────────

    const origFetch = window.fetch;
    window.fetch = function(...args) {
        return origFetch.apply(this, arguments).then(response => {
            if (isExtracting) {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                if (url && (url.includes('/api/') || url.includes('graphql'))) {
                    response.clone().text().then(text => {
                        try {
                            const data = JSON.parse(text);
                            processNetworkData(data);
                        } catch (e) {}
                    }).catch(() => {});
                }
            }
            return response;
        });
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
        this.addEventListener('load', function() {
            if (isExtracting && this._url) {
                if (this._url.includes('/api/') || this._url.includes('graphql')) {
                    try {
                        const data = JSON.parse(this.responseText);
                        processNetworkData(data);
                    } catch (e) {}
                }
            }
        });
        return origSend.apply(this, arguments);
    };

    function processNetworkData(data) {
        const posts = [];
        walkForPosts(data, posts);
        posts.forEach(post => {
            if (post.shortcode && !processedShortcodes.has(post.shortcode)) {
                processedShortcodes.add(post.shortcode);
                sendToServer(post);
            }
        });
    }

    // ─── Send to Server ──────────────────────────────────────────────

    async function sendToServer(post) {
        // Check stop date
        if (stopDate && post.taken_at > 0) {
            const postDate = new Date(post.taken_at * 1000);
            if (postDate < stopDate) {
                log(`Stop date reached. Skipping ${post.shortcode}`, 'warn');
                isExtracting = false;
                updateButtons();
                return;
            }
        }

        try {
            const resp = await fetch(`${API_SERVER}/api/posts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(post)
            });
            if (resp.ok) {
                log(`Sent: ${post.shortcode} (${post.date})`, 'ok');
                updateUI();
            }
        } catch (e) {
            log(`Failed: ${post.shortcode}`, 'err');
        }
    }

    async function sendShortcode(shortcode, imageUrl, isVideo) {
        try {
            const resp = await fetch(`${API_SERVER}/api/shortcode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shortcode,
                    image_url: imageUrl || '',
                    is_video: isVideo || false
                })
            });
            if (resp.ok) {
                const result = await resp.json();
                log(`Saved: ${shortcode}`, 'ok');
                updateUI();
            }
        } catch (e) {}
    }

    // ─── UI ───────────────────────────────────────────────────────────

    function createUI() {
        const panel = document.createElement('div');
        panel.id = 'pe3000';
        panel.innerHTML = `
            <style>
                #pe3000 { position: fixed; bottom: 20px; right: 20px; z-index: 999999; font-family: -apple-system, sans-serif; font-size: 13px; }
                #pe3000-toggle { width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #8b5cf6); border: none; color: white; cursor: pointer; box-shadow: 0 4px 12px rgba(99,102,241,0.4); font-size: 20px; display: flex; align-items: center; justify-content: center; }
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
                <label>Stop date (optional)</label>
                <input type="date" id="pe3000-date" value="2025-12-16">
                <button class="pe3000-start" id="pe3000-start">Start Extracting</button>
                <button class="pe3000-stop" id="pe3000-stop" style="display:none">Stop</button>
                <div class="pe3000-stats">Posts found: <span id="pe3000-count">0</span></div>
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

    function updateButtons() {
        document.getElementById('pe3000-start').style.display = isExtracting ? 'none' : 'block';
        document.getElementById('pe3000-stop').style.display = isExtracting ? 'block' : 'none';
    }

    function updateUI() {
        const el = document.getElementById('pe3000-count');
        if (el) el.textContent = processedShortcodes.size;
    }

    // ─── Extract Logic ────────────────────────────────────────────────

    let scrollInterval = null;

    function startExtracting() {
        const dateVal = document.getElementById('pe3000-date').value;
        stopDate = dateVal ? new Date(dateVal) : null;
        isExtracting = true;
        updateButtons();
        log(`Started. Stop date: ${dateVal || 'none'}`, 'ok');

        // Extract from page data
        const pagePosts = extractFromSharedData();
        if (pagePosts.length > 0) {
            log(`Found ${pagePosts.length} posts in page data`, 'ok');
            pagePosts.forEach(post => {
                if (!processedShortcodes.has(post.shortcode)) {
                    processedShortcodes.add(post.shortcode);
                    sendToServer(post);
                }
            });
        }

        // Extract from DOM
        extractAndSendDOM();

        // Start scrolling
        scrollInterval = setInterval(() => {
            if (!isExtracting) {
                clearInterval(scrollInterval);
                return;
            }
            extractAndSendDOM();
            window.scrollTo(0, document.body.scrollHeight);
        }, 2000 + Math.random() * 3000);
    }

    function extractAndSendDOM() {
        const domPosts = extractFromDOM();
        domPosts.forEach(post => {
            if (!processedShortcodes.has(post.shortcode)) {
                processedShortcodes.add(post.shortcode);
                sendShortcode(post.shortcode, post.image_url, post.is_video);
            }
        });
    }

    function stopExtracting() {
        isExtracting = false;
        if (scrollInterval) clearInterval(scrollInterval);
        updateButtons();
        log('Stopped.', 'warn');
    }

    // ─── Init ─────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }
    log('Loaded. Click ⛏ to start.', 'ok');
})();
