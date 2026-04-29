// ==UserScript==
// @name         Post Extractor 3000
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Extract Instagram posts via API interception
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

    // ─── Intercept XHR ───────────────────────────────────────────────

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function() {
        this.addEventListener('load', function() {
            if (!isExtracting) return;
            if (!this._url) return;

            if (this._url.includes('/api/v1/feed/') ||
                this._url.includes('/graphql/query') ||
                this._url.includes('/api/graphql')) {
                try {
                    const data = JSON.parse(this.responseText);
                    processResponse(data);
                } catch (e) {}
            }
        });
        return originalSend.apply(this, arguments);
    };

    // ─── Intercept Fetch ──────────────────────────────────────────────

    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        return originalFetch.apply(this, arguments).then(response => {
            if (!isExtracting) return response;

            const urlStr = typeof url === 'string' ? url : url.url;
            if (urlStr && (
                urlStr.includes('/api/v1/feed/') ||
                urlStr.includes('/graphql/query') ||
                urlStr.includes('/api/graphql')
            )) {
                response.clone().json().then(data => {
                    processResponse(data);
                }).catch(() => {});
            }
            return response;
        });
    };

    // ─── Process Response ─────────────────────────────────────────────

    function processResponse(data) {
        const posts = extractPosts(data);
        posts.forEach(post => {
            if (post.shortcode && !processedShortcodes.has(post.shortcode)) {
                processedShortcodes.add(post.shortcode);

                if (stopDate && post.taken_at > 0) {
                    const postDate = new Date(post.taken_at * 1000);
                    if (postDate < stopDate) {
                        log(`Reached stop date. Skipping ${post.shortcode}`, 'warn');
                        return;
                    }
                }

                sendToServer(post);
            }
        });
    }

    function extractPosts(data) {
        const posts = [];

        function walk(obj) {
            if (!obj || typeof obj !== 'object') return;

            if (obj.shortcode && (obj.image_versions2 || obj.video_versions || obj.display_url)) {
                posts.push(parseNode(obj));
                return;
            }

            if (Array.isArray(obj)) {
                obj.forEach(walk);
            } else {
                Object.values(obj).forEach(walk);
            }
        }

        walk(data);
        return posts;
    }

    function parseNode(node) {
        const shortcode = node.shortcode || node.code || '';
        const postId = node.pk || node.id || shortcode;

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
        }

        let videoUrl = '';
        if (node.video_versions?.[0]?.url) {
            videoUrl = node.video_versions[0].url;
        } else if (node.video_url) {
            videoUrl = node.video_url;
        }

        const takenAt = node.taken_at || 0;
        const mediaType = node.media_type || 1;

        return {
            shortcode,
            post_id: String(postId),
            caption,
            image_url: imageUrl,
            video_url: videoUrl,
            taken_at: takenAt,
            media_type: mediaType,
            date: takenAt ? new Date(takenAt * 1000).toISOString().split('T')[0] : 'unknown'
        };
    }

    // ─── Send to Server ──────────────────────────────────────────────

    async function sendToServer(post) {
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
            log(`Failed to send ${post.shortcode}: ${e.message}`, 'err');
        }
    }

    // ─── Logging ──────────────────────────────────────────────────────

    function log(msg, level = 'info') {
        const styles = {
            info: 'color: #a855f7',
            ok: 'color: #22c55e',
            warn: 'color: #eab308',
            err: 'color: #ef4444'
        };
        console.log(`%c[PostExtractor] ${msg}`, styles[level] || styles.info);
    }

    // ─── Control Panel ────────────────────────────────────────────────

    function createUI() {
        const panel = document.createElement('div');
        panel.id = 'pe3000-panel';
        panel.innerHTML = `
            <style>
                #pe3000-panel {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    z-index: 999999;
                    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                    font-size: 13px;
                }
                #pe3000-toggle {
                    width: 48px;
                    height: 48px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #6366f1, #8b5cf6);
                    border: none;
                    color: white;
                    cursor: pointer;
                    box-shadow: 0 4px 12px rgba(99,102,241,0.4);
                    font-size: 20px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                #pe3000-card {
                    display: none;
                    background: #1a1a2e;
                    border: 1px solid rgba(99,102,241,0.3);
                    border-radius: 16px;
                    padding: 16px;
                    width: 280px;
                    margin-bottom: 8px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                }
                #pe3000-card.open { display: block; }
                #pe3000-card h3 {
                    margin: 0 0 12px;
                    color: white;
                    font-size: 14px;
                    font-weight: 700;
                }
                #pe3000-card label {
                    color: #94a3b8;
                    font-size: 11px;
                    display: block;
                    margin-bottom: 4px;
                }
                #pe3000-card input {
                    width: 100%;
                    padding: 8px;
                    border-radius: 8px;
                    border: 1px solid rgba(255,255,255,0.1);
                    background: #0f0f1a;
                    color: white;
                    font-size: 12px;
                    margin-bottom: 10px;
                    box-sizing: border-box;
                }
                #pe3000-card button {
                    width: 100%;
                    padding: 10px;
                    border-radius: 10px;
                    border: none;
                    font-weight: 600;
                    cursor: pointer;
                    font-size: 13px;
                    margin-bottom: 6px;
                }
                .pe3000-start {
                    background: linear-gradient(135deg, #6366f1, #8b5cf6);
                    color: white;
                }
                .pe3000-stop {
                    background: rgba(239,68,68,0.2);
                    color: #ef4444;
                    border: 1px solid rgba(239,68,68,0.3) !important;
                }
                .pe3000-stats {
                    color: #94a3b8;
                    font-size: 11px;
                    margin-top: 8px;
                    padding-top: 8px;
                    border-top: 1px solid rgba(255,255,255,0.1);
                }
                .pe3000-stats span { color: #8b5cf6; font-weight: 600; }
            </style>
            <div id="pe3000-card">
                <h3>Post Extractor 3000</h3>
                <label>Stop date (optional)</label>
                <input type="date" id="pe3000-date" value="2025-12-16">
                <button class="pe3000-start" id="pe3000-start">Start Extracting</button>
                <button class="pe3000-stop" id="pe3000-stop" style="display:none">Stop</button>
                <div class="pe3000-stats">
                    Posts found: <span id="pe3000-count">0</span>
                </div>
            </div>
            <button id="pe3000-toggle">⛏</button>
        `;

        document.body.appendChild(panel);

        document.getElementById('pe3000-toggle').addEventListener('click', () => {
            document.getElementById('pe3000-card').classList.toggle('open');
        });

        document.getElementById('pe3000-start').addEventListener('click', () => {
            const dateVal = document.getElementById('pe3000-date').value;
            stopDate = dateVal ? new Date(dateVal) : null;
            isExtracting = true;
            document.getElementById('pe3000-start').style.display = 'none';
            document.getElementById('pe3000-stop').style.display = 'block';
            log(`Started extracting. Stop date: ${dateVal || 'none'}`, 'ok');
            triggerScroll();
        });

        document.getElementById('pe3000-stop').addEventListener('click', () => {
            isExtracting = false;
            document.getElementById('pe3000-start').style.display = 'block';
            document.getElementById('pe3000-stop').style.display = 'none';
            log('Stopped extracting.', 'warn');
        });
    }

    function updateUI() {
        const el = document.getElementById('pe3000-count');
        if (el) el.textContent = processedShortcodes.size;
    }

    function triggerScroll() {
        if (!isExtracting) return;
        window.scrollTo(0, document.body.scrollHeight);
        const delay = 2000 + Math.random() * 3000;
        setTimeout(triggerScroll, delay);
    }

    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }

    log('Loaded. Click ⛏ to start.', 'ok');
})();
