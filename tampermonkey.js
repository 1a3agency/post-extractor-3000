// ==UserScript==
// @name         Post Extractor 3000
// @namespace    http://tampermonkey.net/
// @version      9.0
// @description  Extract Instagram posts with captions and videos
// @match        https://www.instagram.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      instagram.com
// @connect      cdninstagram.com
// @connect      fbcdn.net
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
    const allLinks = new Set();

    function log(msg, level = 'info') {
        const styles = { info: 'color: #a855f7', ok: 'color: #22c55e', warn: 'color: #eab308', err: 'color: #ef4444' };
        console.log(`%c[PE3000] ${msg}`, styles[level] || styles.info);
    }

    // ─── Extract post links from DOM ──────────────────────────────────

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

            // Save full link
            const fullUrl = `https://www.instagram.com/p/${shortcode}/`;
            allLinks.add(fullUrl);

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

    // ─── Fetch post details from Instagram (with your session) ────────

    function fetchPostDetails(shortcode) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.instagram.com/p/${shortcode}/`,
                onload: function(resp) {
                    const html = resp.responseText;
                    let caption = '';
                    let imageUrl = '';
                    let videoUrl = '';

                    try {
                        // Look for shared data with post info
                        const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});<\/script>/);
                        if (sharedDataMatch) {
                            const data = JSON.parse(sharedDataMatch[1]);
                            const media = findMediaInObject(data);
                            if (media) {
                                caption = media.caption?.text || '';
                                imageUrl = media.image_versions2?.candidates?.[0]?.url || media.display_url || '';
                                if (media.video_versions?.length) {
                                    videoUrl = media.video_versions[0].url;
                                }
                            }
                        }

                        // Fallback: look for additional data
                        if (!caption || !imageUrl) {
                            const addDataMatch = html.match(/window\.__additionalDataLoaded\('[^']+',\s*({.+?})\)/);
                            if (addDataMatch) {
                                const data = JSON.parse(addDataMatch[1]);
                                const media = findMediaInObject(data);
                                if (media) {
                                    if (!caption) caption = media.caption?.text || '';
                                    if (!imageUrl) imageUrl = media.image_versions2?.candidates?.[0]?.url || media.display_url || '';
                                    if (!videoUrl && media.video_versions?.length) {
                                        videoUrl = media.video_versions[0].url;
                                    }
                                }
                            }
                        }

                        // Fallback: look for JSON in script tags
                        if (!caption || !imageUrl) {
                            const scriptTags = html.match(/<script type="application\/json"[^>]*>(.+?)<\/script>/g);
                            if (scriptTags) {
                                for (const tag of scriptTags) {
                                    const jsonMatch = tag.match(/>(.+?)<\/script>/);
                                    if (jsonMatch) {
                                        try {
                                            const data = JSON.parse(jsonMatch[1]);
                                            const media = findMediaInObject(data);
                                            if (media) {
                                                if (!caption) caption = media.caption?.text || '';
                                                if (!imageUrl) imageUrl = media.image_versions2?.candidates?.[0]?.url || media.display_url || '';
                                                if (!videoUrl && media.video_versions?.length) {
                                                    videoUrl = media.video_versions[0].url;
                                                }
                                                break;
                                            }
                                        } catch (e) {}
                                    }
                                }
                            }
                        }

                    } catch (e) {
                        log(`Parse error for ${shortcode}: ${e.message}`, 'err');
                    }

                    resolve({ caption, imageUrl, videoUrl });
                },
                onerror: function() {
                    resolve({ caption: '', imageUrl: '', videoUrl: '' });
                }
            });
        });
    }

    function findMediaInObject(obj, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 15) return null;

        if (obj.shortcode && (obj.image_versions2 || obj.video_versions || obj.display_url)) {
            return obj;
        }

        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = findMediaInObject(item, depth + 1);
                if (found) return found;
            }
        } else {
            for (const key of Object.keys(obj)) {
                const found = findMediaInObject(obj[key], depth + 1);
                if (found) return found;
            }
        }

        return null;
    }

    // ─── Send to server ───────────────────────────────────────────────

    function sendToServer(post, callback) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API_SERVER}/api/full`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(post),
            onload: function(resp) {
                if (resp.status === 200) {
                    savedCount++;
                    updateUI();
                    log(`Saved: ${post.shortcode} (${savedCount}/${maxPosts}) caption=${post.caption ? 'yes' : 'no'} video=${post.video_url ? 'yes' : 'no'}`, 'ok');
                }
                if (callback) callback();
            },
            onerror: function() {
                log(`Failed: ${post.shortcode}`, 'err');
                if (callback) callback();
            }
        });
    }

    // ─── Queue processing ─────────────────────────────────────────────

    async function processQueue() {
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

        // Fetch full details from Instagram
        log(`Fetching: ${post.shortcode}...`, 'info');
        const details = await fetchPostDetails(post.shortcode);

        post.caption = details.caption || '';
        post.image_url = details.imageUrl || post.image_url;
        post.video_url = details.videoUrl || '';

        sendToServer(post, () => {
            if (isExtracting && savedCount < maxPosts) {
                setTimeout(processQueue, 500);
            }
        });
    }

    // ─── UI ───────────────────────────────────────────────────────────

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

        // Save links to file
        saveLinks();
    }

    function saveLinks() {
        const links = Array.from(allLinks).join('\n');
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API_SERVER}/api/links`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ links: Array.from(allLinks) }),
            onload: function() {
                log(`Saved ${allLinks.size} links to file`, 'ok');
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }
    log('Loaded. Click ⛏ to start.', 'ok');
})();
