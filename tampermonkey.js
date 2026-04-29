// ==UserScript==
// @name         Post Extractor 3000
// @namespace    http://tampermonkey.net/
// @version      15.0
// @description  Extract Instagram posts by clicking each post
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
    const allLinks = new Set();
    const postElements = [];

    function log(msg, level = 'info') {
        const styles = { info: 'color: #a855f7', ok: 'color: #22c55e', warn: 'color: #eab308', err: 'color: #ef4444', debug: 'color: #64748b' };
        console.log(`%c[PE3000] ${msg}`, styles[level] || styles.info);
    }

    function wait(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ─── Collect post links from page ─────────────────────────────────

    function collectPostLinks() {
        const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
        const seen = new Set();

        links.forEach(link => {
            const match = link.href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]{5,})/);
            if (!match || seen.has(match[1])) return;
            seen.add(match[1]);

            const shortcode = match[1];
            if (processedShortcodes.has(shortcode)) return;

            const rect = link.getBoundingClientRect();
            if (rect.top < -100) return;

            allLinks.add(`https://www.instagram.com/p/${shortcode}/`);

            if (!postElements.find(p => p.shortcode === shortcode)) {
                postElements.push({
                    shortcode,
                    element: link,
                    is_video: link.href.includes('/reel/'),
                    top: rect.top + window.scrollY
                });
            }
        });

        postElements.sort((a, b) => a.top - b.top);
    }

    // ─── Click post and extract data from modal ───────────────────────

    async function extractFromPost(postInfo) {
        const { shortcode, element } = postInfo;

        // Click the post
        element.click();
        await wait(3000);

        // Look for the modal/dialog
        const modal = document.querySelector('div[role="dialog"]') ||
                      document.querySelector('article[role="presentation"]');

        if (!modal) {
            log(`${shortcode}: no modal found`, 'warn');
            closePost();
            return { caption: '', images: [], video_url: '' };
        }

        let caption = '';
        let images = [];
        let videoUrl = '';

        // ─── Get caption ──────────────────────────────────────────────
        // Look for caption in various locations
        const captionSelectors = [
            'h1',                                          // Main caption
            'ul[class*="x"] li span[dir="auto"]',          // Caption span
            'span[dir="auto"]',                            // Auto-direction spans
            '[class*="Caption"]',                          // Caption class
            'div[class*="x"] > ul > li > div > span',      // Nested spans
        ];

        for (const sel of captionSelectors) {
            const els = modal.querySelectorAll(sel);
            for (const el of els) {
                const text = el.textContent.trim();
                // Caption should be longer than just username or emoji
                if (text.length > 20 && !text.includes('Verified') && !text.includes('followers')) {
                    caption = text;
                    break;
                }
            }
            if (caption) break;
        }

        // ─── Handle carousel (click through all slides) ───────────────
        const nextBtn = modal.querySelector('button[aria-label="Next"]') ||
                       modal.querySelector('svg[aria-label="Next"]')?.closest('button');

        let slideCount = 0;
        const maxSlides = 10;

        while (slideCount < maxSlides) {
            await wait(500);

            // Get ALL images in modal, be less restrictive
            const imgEls = modal.querySelectorAll('img[src*="fbcdn.net"]');
            for (const img of imgEls) {
                const src = img.src;
                // Skip only profile pics and tiny icons
                if (src.includes('s150x150') || src.includes('s32x32')) continue;
                if (src.includes('profile_pic')) continue;
                if (!images.includes(src)) {
                    images.push(src);
                    log(`  Found image: ${src.substring(0, 50)}...`, 'debug');
                }
            }

            // Get video
            const video = modal.querySelector('video');
            if (video && !videoUrl) {
                if (video.poster && !images.includes(video.poster)) {
                    images.push(video.poster);
                }
                videoUrl = video.src || '';
                if (videoUrl.startsWith('blob:')) {
                    videoUrl = '';
                }
            }

            // Try to click next slide
            const nextButton = modal.querySelector('button[aria-label="Next"]') ||
                              modal.querySelector('svg[aria-label="Next"]')?.closest('button');
            if (nextButton && !nextButton.disabled) {
                nextButton.click();
                await wait(1000);
                slideCount++;
            } else {
                break;
            }
        }

        // Final catch - get any remaining images
        const finalImgs = modal.querySelectorAll('img[src*="fbcdn.net"]');
        for (const img of finalImgs) {
            const src = img.src;
            if (!src.includes('s150x150') && !src.includes('s32x32') && !src.includes('profile_pic')) {
                if (!images.includes(src)) {
                    images.push(src);
                }
            }
        }

        // Get video if still not found
        const video = modal.querySelector('video');
        if (video && !videoUrl) {
            if (video.poster && images.length === 0) {
                images.push(video.poster);
            }
            videoUrl = video.src || '';
            if (videoUrl.startsWith('blob:')) {
                videoUrl = '';
            }
        }

        log(`${shortcode}: caption=${caption ? '✓' : '✗'} images=${images.length} video=${videoUrl ? '✓' : '✗'}`, 'info');

        // Close the modal
        closePost();
        await wait(500);

        return { caption, images, video_url: videoUrl };
    }

    function closePost() {
        // Try multiple ways to close
        const closeBtn = document.querySelector('svg[aria-label="Close"]')?.closest('button') ||
                        document.querySelector('[class*="close"]') ||
                        document.querySelector('button[class*="Close"]');
        if (closeBtn) {
            closeBtn.click();
            return;
        }

        // Press Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
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
                    log(`Saved: ${post.shortcode} (${savedCount}/${maxPosts}) caption=${post.caption ? '✓' : '✗'} images=${post.images?.length || 0} video=${post.video_url ? '✓' : '✗'}`, 'ok');
                }
                if (callback) callback();
            },
            onerror: function() {
                log(`Failed: ${post.shortcode}`, 'err');
                if (callback) callback();
            }
        });
    }

    function saveLinks() {
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

    // ─── Main extraction loop ─────────────────────────────────────────

    async function extractPosts() {
        while (isExtracting && savedCount < maxPosts) {
            // Collect more links if needed
            collectPostLinks();

            // Find next unprocessed post
            const nextPost = postElements.find(p => !processedShortcodes.has(p.shortcode));
            if (!nextPost) {
                // Scroll to get more
                window.scrollBy(0, 500);
                await wait(2000);
                collectPostLinks();
                continue;
            }

            if (savedCount >= maxPosts) break;

            processedShortcodes.add(nextPost.shortcode);

            // Extract data by clicking the post
            const data = await extractFromPost(nextPost);

            // Send to server
            await new Promise((resolve) => {
                sendToServer({
                    shortcode: nextPost.shortcode,
                    caption: data.caption,
                    image_url: data.image_url,
                    video_url: data.video_url,
                    is_video: nextPost.is_video
                }, resolve);
            });

            await wait(1000);
        }

        if (isExtracting) {
            log(`Done! Saved ${savedCount} posts.`, 'ok');
            isExtracting = false;
            updateButtons();
            saveLinks();
        }
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
        postElements.length = 0;
        allLinks.clear();
        isExtracting = true;
        updateUI();
        updateButtons();
        log(`Started. Grabbing ${maxPosts} posts.`, 'ok');

        extractPosts();
    }

    function stopExtracting() {
        isExtracting = false;
        updateButtons();
        log(`Stopped. Saved ${savedCount} posts.`, 'warn');
        saveLinks();
        closePost();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }
    log('Loaded. Click ⛏ to start.', 'ok');
})();
