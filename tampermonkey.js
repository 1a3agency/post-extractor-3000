// ==UserScript==
// @name         Post Extractor 3000
// @namespace    http://tampermonkey.net/
// @version      8.0
// @description  Extract Instagram posts (count-based)
// @match        https://www.instagram.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const API_SERVER = 'http://localhost:5003';
    let isExtracting = false;
    let maxPosts = 0;
    let savedCount = 0;
    let scrollInterval = null;
    const processedShortcodes = new Set();
    const queue = [];

    function log(msg, level = 'info') {
        const styles = { info: 'color: #a855f7', ok: 'color: #22c55e', warn: 'color: #eab308', err: 'color: #ef4444' };
        console.log(`%c[PE3000] ${msg}`, styles[level] || styles.info);
    }

    function extractPosts() {
        const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
        const found = [];
        const seen = new Set();

        links.forEach(link => {
            const match = link.href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]{5,})/);
            if (!match || seen.has(match[1])) return;
            seen.add(match[1]);

            const shortcode = match[1];
            const rect = link.getBoundingClientRect();
            if (rect.top < -50) return;

            let imageUrl = '';
            const img = link.querySelector('img');
            if (img) imageUrl = img.src || '';

            found.push({
                shortcode,
                image_url: imageUrl,
                is_video: link.href.includes('/reel/'),
                top: rect.top + window.scrollY
            });
        });

        found.sort((a, b) => a.top - b.top);
        return found;
    }

    function sendToServer(post, callback) {
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
                    savedCount++;
                    updateUI();
                    log(`Saved: ${post.shortcode} (${savedCount}/${maxPosts})`, 'ok');
                }
                if (callback) callback();
            },
            onerror: function() {
                log(`Failed: ${post.shortcode}`, 'err');
                if (callback) callback();
            }
        });
    }

    function processQueue() {
        if (!isExtracting || savedCount >= maxPosts || queue.length === 0) {
            if (savedCount >= maxPosts && isExtracting) {
                log(`Done! Saved ${savedCount} posts.`, 'ok');
                isExtracting = false;
                if (scrollInterval) clearInterval(scrollInterval);
                updateButtons();
            }
            return;
        }

        const post = queue.shift();
        if (processedShortcodes.has(post.shortcode)) {
            processQueue();
            return;
        }

        processedShortcodes.add(post.shortcode);
        sendToServer(post, () => {
            if (isExtracting && savedCount < maxPosts) {
                setTimeout(processQueue, 200);
            }
        });
    }

    function createUI() {
        const panel = document.createElement('div');
        panel.id = 'pe3000';
        panel.innerHTML = `
            <style>
                #pe3000 { position: fixed; bottom: 20px; right: 20px; z-index: 999999; font-family: -apple-system, sans-serif; font-size: 13px; }
                #pe3000-toggle { width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #8b5cf6); border: none; color: white; cursor: pointer; box-shadow: 0 4px 12px rgba(99,102,241,0.4); font-size: 20px; }
                #pe3000-card { display: none; background: #1a1a2e; border: 1px solid rgba(99,102,241,0.3); border-radius: 16px; padding: 16px; width: 260px; margin-bottom: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
                #pe3000-card.open { display: block; }
                #pe3000-card h3 { margin: 0 0 12px; color: white; font-size: 14px; font-weight: 700; }
                #pe3000-card label { color: #94a3b8; font-size: 11px; display: block; margin-bottom: 4px; }
                #pe3000-card input { width: 100%; padding: 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: #0f0f1a; color: white; font-size: 14px; margin-bottom: 10px; box-sizing: border-box; text-align: center; }
                #pe3000-card button { width: 100%; padding: 10px; border-radius: 10px; border: none; font-weight: 600; cursor: pointer; font-size: 13px; margin-bottom: 6px; }
                .pe3000-start { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; }
                .pe3000-stop { background: rgba(239,68,68,0.2); color: #ef4444; border: 1px solid rgba(239,68,68,0.3) !important; }
                .pe3000-stats { color: #94a3b8; font-size: 11px; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); }
                .pe3000-stats span { color: #8b5cf6; font-weight: 600; }
            </style>
            <div id="pe3000-card">
                <h3>⛏ Post Extractor 3000</h3>
                <label>Number of posts to grab</label>
                <input type="number" id="pe3000-count" value="55" min="1">
                <button class="pe3000-start" id="pe3000-start">Start</button>
                <button class="pe3000-stop" id="pe3000-stop" style="display:none">Stop</button>
                <div class="pe3000-stats">Saved: <span id="pe3000-saved">0 / 55</span></div>
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
        const el = document.getElementById('pe3000-saved');
        if (el) el.textContent = `${savedCount} / ${maxPosts}`;
    }

    function updateButtons() {
        document.getElementById('pe3000-start').style.display = isExtracting ? 'none' : 'block';
        document.getElementById('pe3000-stop').style.display = isExtracting ? 'block' : 'none';
    }

    function startExtracting() {
        maxPosts = parseInt(document.getElementById('pe3000-count').value) || 55;
        savedCount = 0;
        processedShortcodes.clear();
        queue.length = 0;
        isExtracting = true;
        updateUI();
        updateButtons();
        log(`Started. Grabbing ${maxPosts} posts.`, 'ok');

        const posts = extractPosts();
        posts.forEach(p => {
            if (!processedShortcodes.has(p.shortcode) && queue.length + savedCount < maxPosts) {
                queue.push(p);
            }
        });
        processQueue();

        scrollInterval = setInterval(() => {
            if (!isExtracting || savedCount >= maxPosts) {
                clearInterval(scrollInterval);
                return;
            }

            const newPosts = extractPosts();
            newPosts.forEach(p => {
                if (!processedShortcodes.has(p.shortcode) && queue.length + savedCount < maxPosts) {
                    queue.push(p);
                }
            });

            if (queue.length > 0) processQueue();
            window.scrollTo(0, document.body.scrollHeight);
        }, 3000);
    }

    function stopExtracting() {
        isExtracting = false;
        if (scrollInterval) clearInterval(scrollInterval);
        updateButtons();
        log(`Stopped. Saved ${savedCount} posts.`, 'warn');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }
    log('Loaded. Click ⛏ to start.', 'ok');
})();
