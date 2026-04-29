// ==UserScript==
// @name         Post Extractor 3000
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  Extract Instagram posts with dates
// @match        https://www.instagram.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const API_SERVER = 'http://localhost:5003';
    let isExtracting = false;
    let stopDate = null;
    let collectedPosts = new Map(); // shortcode -> {shortcode, date, image_url}
    let scrollInterval = null;

    function log(msg, level = 'info') {
        const styles = { info: 'color: #a855f7', ok: 'color: #22c55e', warn: 'color: #eab308', err: 'color: #ef4444' };
        console.log(`%c[PE3000] ${msg}`, styles[level] || styles.info);
    }

    // ─── Get post date from embed page ────────────────────────────────

    function getPostDate(shortcode) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.instagram.com/p/${shortcode}/embed/`,
                onload: function(resp) {
                    if (resp.status !== 200) {
                        resolve(null);
                        return;
                    }

                    const html = resp.responseText;

                    // Look for timestamp in various formats
                    let date = null;

                    // Pattern 1: datetime attribute
                    const timeMatch = html.match(/datetime="([^"]+)"/);
                    if (timeMatch) {
                        date = timeMatch[1].split('T')[0];
                    }

                    // Pattern 2: "January 1, 2025" format
                    if (!date) {
                        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                                           'July', 'August', 'September', 'October', 'November', 'December'];
                        const datePattern = new RegExp(`(${monthNames.join('|')})\\s+\\d{1,2},\\s+\\d{4}`);
                        const match = html.match(datePattern);
                        if (match) {
                            const parsed = new Date(match[1]);
                            if (!isNaN(parsed)) {
                                date = parsed.toISOString().split('T')[0];
                            }
                        }
                    }

                    // Pattern 3: "Jan 1, 2025" format
                    if (!date) {
                        const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                                            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                        const datePattern = new RegExp(`(${shortMonths.join('|')})\\s+\\d{1,2},\\s+\\d{4}`);
                        const match = html.match(datePattern);
                        if (match) {
                            const parsed = new Date(match[1]);
                            if (!isNaN(parsed)) {
                                date = parsed.toISOString().split('T')[0];
                            }
                        }
                    }

                    resolve(date);
                },
                onerror: function() {
                    resolve(null);
                }
            });
        });
    }

    // ─── Extract post links from DOM ──────────────────────────────────

    function extractPostLinks() {
        const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
        const found = [];

        links.forEach(link => {
            const match = link.href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]{5,})/);
            if (!match) return;

            const shortcode = match[1];
            if (collectedPosts.has(shortcode)) return;

            const rect = link.getBoundingClientRect();
            if (rect.top < -100) return; // skip header

            let imageUrl = '';
            const img = link.querySelector('img');
            if (img) imageUrl = img.src || '';

            const isReel = link.href.includes('/reel/');

            collectedPosts.set(shortcode, {
                shortcode,
                image_url: imageUrl,
                is_video: isReel,
                date: null,
                top: rect.top + window.scrollY
            });

            found.push(shortcode);
        });

        return found;
    }

    // ─── Send to server ───────────────────────────────────────────────

    function sendToServer(post) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API_SERVER}/api/shortcode`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                shortcode: post.shortcode,
                image_url: post.image_url,
                is_video: post.is_video
            }),
            onload: function(resp) {
                if (resp.status === 200) {
                    updateUI();
                    log(`Saved: ${post.shortcode} (${post.date || 'no date'})`, 'ok');
                }
            }
        });
    }

    // ─── Process collected posts ──────────────────────────────────────

    async function processCollectedPosts() {
        const posts = Array.from(collectedPosts.values())
            .filter(p => p.date === null) // only process posts without dates
            .sort((a, b) => a.top - b.top); // top to bottom (newest first)

        for (const post of posts) {
            if (!isExtracting) break;

            // Get date
            const date = await getPostDate(post.shortcode);
            post.date = date || 'unknown';

            log(`${post.shortcode}: ${post.date}`, 'info');

            // Check if we hit the stop date
            if (stopDate && date) {
                const postDate = new Date(date);
                const cutoff = new Date(stopDate);
                if (postDate < cutoff) {
                    log(`Reached stop date: ${date} < ${stopDate}`, 'warn');
                    log(`Saving posts collected so far...`, 'info');
                    await saveAllPosts();
                    isExtracting = false;
                    if (scrollInterval) clearInterval(scrollInterval);
                    updateButtons();
                    return;
                }
            }

            // Small delay between requests
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // ─── Save all collected posts to server ───────────────────────────

    async function saveAllPosts() {
        const posts = Array.from(collectedPosts.values())
            .filter(p => p.date !== null)
            .sort((a, b) => {
                if (!a.date || a.date === 'unknown') return 1;
                if (!b.date || b.date === 'unknown') return -1;
                return new Date(b.date) - new Date(a.date); // newest first
            });

        // Only save posts before the stop date
        let toSave = posts;
        if (stopDate) {
            const cutoff = new Date(stopDate);
            toSave = posts.filter(p => {
                if (!p.date || p.date === 'unknown') return false;
                return new Date(p.date) >= cutoff;
            });
        }

        log(`Saving ${toSave.length} posts...`, 'ok');

        for (const post of toSave) {
            if (!isExtracting) break;
            sendToServer(post);
            await new Promise(r => setTimeout(r, 300));
        }

        log(`Done! Saved ${toSave.length} posts.`, 'ok');
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
                <label>Stop date (grab posts from newest to this date)</label>
                <input type="date" id="pe3000-date" value="2025-12-16">
                <button class="pe3000-start" id="pe3000-start">Start Extracting</button>
                <button class="pe3000-stop" id="pe3000-stop" style="display:none">Stop</button>
                <div class="pe3000-stats">
                    Posts found: <span id="pe3000-found">0</span><br>
                    Posts saved: <span id="pe3000-count">0</span>
                </div>
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
        const foundEl = document.getElementById('pe3000-found');
        const countEl = document.getElementById('pe3000-count');
        if (foundEl) foundEl.textContent = collectedPosts.size;
        if (countEl) countEl.textContent = collectedPosts.size;
    }

    function updateButtons() {
        document.getElementById('pe3000-start').style.display = isExtracting ? 'none' : 'block';
        document.getElementById('pe3000-stop').style.display = isExtracting ? 'block' : 'none';
    }

    // ─── Extract Logic ────────────────────────────────────────────────

    function startExtracting() {
        const dateVal = document.getElementById('pe3000-date').value;
        stopDate = dateVal || null;
        isExtracting = true;
        collectedPosts.clear();
        updateUI();
        updateButtons();

        log(`Started. Stop date: ${stopDate || 'none'}`, 'ok');

        // Phase 1: Scroll and collect links
        log('Phase 1: Collecting post links...', 'info');

        scrollInterval = setInterval(() => {
            if (!isExtracting) {
                clearInterval(scrollInterval);
                return;
            }

            const newLinks = extractPostLinks();
            updateUI();

            // Check if we've reached the bottom
            const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 100;

            if (newLinks.length === 0 && atBottom) {
                log('Reached bottom. Starting date check...', 'info');
                clearInterval(scrollInterval);

                // Phase 2: Get dates for all posts
                processCollectedPosts();
                return;
            }

            window.scrollTo(0, document.body.scrollHeight);
        }, 3000);
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
