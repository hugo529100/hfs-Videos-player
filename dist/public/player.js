'use strict';
{
    let { React, h, HFS } = window;

    if (!React) {
        if (window.preact) {
            React = window.preact;
            if (!React.Component && window.preact.Component) {
                React.Component = window.preact.Component;
            }
        } else if (HFS && HFS.React) {
            React = HFS.React;
        }
    }

    if (React) {
        if (!h && React.createElement) {
            h = React.createElement;
        }

        const rawConfig = HFS.getPluginConfig ? HFS.getPluginConfig() : {};

        // HFS.getPluginPublic() only works while the plugin script is being
        // evaluated synchronously (it reads document.currentScript). Capture
        // the directory now so it can also be used when hls.js is lazily
        // loaded later from playViaHls().
        const PLUGIN_PUBLIC_URL = (() => {
            try {
                const script = document.currentScript;
                if (script && script.src) return new URL('.', script.src).href;
            } catch (e) {}
            try {
                if (HFS && typeof HFS.getPluginPublic === 'function') {
                    const url = HFS.getPluginPublic();
                    if (url) return url;
                }
            } catch (e) {}
            return '/~/plugins/Videos-player+/';
        })();

        const C = {
            autoplay: true,
            controls: true,
            sizingMode: 'fluid',
            enableScrollSeek: true,
            enableDoubleTap: true,
            autoRotate: true,
            preload: 'metadata',
            enableHLS: true,

            enableHotkeys: rawConfig.enableHotkeys ?? true,
            hotkeySeekStep: parseInt(rawConfig.hotkeySeekStep) || 5,
            resumePlayback: rawConfig.resumePlayback ?? true,
            scrollSeekStep: parseFloat(rawConfig.scrollSeekStep) || 1,
            doubleTapSeekSeconds: parseInt(rawConfig.doubleTapSeekSeconds) || 10,
            errorStyle: rawConfig.errorStyle || 'overlay',
            inactivityTimeout: parseInt(rawConfig.inactivityTimeout) || 2000,
            enable_ffmpeg_transcoding: rawConfig.enable_ffmpeg_transcoding ?? false,
            enable_transcoding_seeking: rawConfig.enable_transcoding_seeking ?? false,
            enableSubtitlePluginIntegration: rawConfig.enableSubtitlePluginIntegration ?? true,
        };

        const BRAKE_SEEK_THRESHOLD = 30;
        const VIDEO_EXTS = ['.mp4', '.webm', '.ogv', '.mov'];

        // ============================================================
        // === Fast-forward seeking (smooth seek) ===
        // ============================================================
        // A small forward seek (arrow key, wheel, double tap, progress bar)
        // plays the skipped part at a high rate and stops on the target time
        // instead of jumping there, so the picture and sound fast-forward
        // through the preloaded part. Long jumps and backward seeks keep the
        // instant behaviour; a paused player is never touched, so scrubbing a
        // paused video still shows the usual still-frame preview.
        const SEEK_FF_MIN_SECONDS = 0.3;
        const SEEK_FF_MAX_SECONDS = 10;
        const SEEK_FF_MAX_EXTEND_SECONDS = 30;
        // A discrete forward command (wheel notch / key press / double tap) may
        // extend an ongoing fast-forward only this many times. Beyond that the
        // target stops growing so the scan cannot run away for tens of seconds
        // and become hard to brake. Backward presses use the same limit per
        // quick burst.
        const SEEK_FF_MAX_STACKS = 5;
        const SEEK_REWIND_MAX_STACKS = 5;
        const SEEK_REWIND_WINDOW_MS = 900;
        const SEEK_FF_MIN_RATE = 2;
        const SEEK_FF_MAX_RATE = 8;
        const SEEK_FF_TARGET_MS = 500;
        const SEEK_FF_TIMEOUT_MS = 4000;

        const seekFastForward = {
            player: null,
            target: 0,
            startTime: 0,
            stacks: 0,
            savedRate: 1,
            raf: 0,
            timer: 0,
            onPause: null,
            onEnded: null,
        };

        const isForwardBuffered = (player, target) => {
            try {
                const buffered = player.buffered();
                if (!buffered || !buffered.length) return true;
                const current = player.currentTime();
                for (let i = buffered.length - 1; i >= 0; i--) {
                    if (buffered.start(i) <= current + 0.5) {
                        return target <= buffered.end(i) + 0.5;
                    }
                }
            } catch (e) {}
            return true;
        };

        const seekFastForwardStop = (reason) => {
            const state = seekFastForward;
            const player = state.player;
            if (!player) return;
            state.player = null;
            if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
            if (state.timer) { clearTimeout(state.timer); state.timer = 0; }
            if (player.isDisposed && player.isDisposed()) return;
            if (state.onPause) { player.off('pause', state.onPause); state.onPause = null; }
            if (state.onEnded) { player.off('ended', state.onEnded); state.onEnded = null; }

            try { player.playbackRate(state.savedRate); } catch (e) {}

            if (reason === 'timeout') {
                try {
                    if (state.target - player.currentTime() > 0.25) player.currentTime(state.target);
                } catch (e) {}
            }
            releaseSeekHint();
        };

        const seekDirect = (player, time) => {
            if (seekFastForward.player === player) seekFastForwardStop('cancel');
            if (player && !player.isDisposed()) player.currentTime(time);
        };

        // Backward seeks are instant jumps; cap how many can be stacked in a
        // quick burst, and let an opposite (backward) press brake an active
        // fast-forward instead of seeking.
        const seekRewindBurst = { count: 0, lastAt: 0 };

        const resetSeekRewindBurst = () => {
            seekRewindBurst.count = 0;
            seekRewindBurst.lastAt = 0;
        };

        const takeSeekRewindSlot = () => {
            const now = performance.now();
            if (now - seekRewindBurst.lastAt > SEEK_REWIND_WINDOW_MS) {
                seekRewindBurst.count = 0;
            }
            if (seekRewindBurst.count >= SEEK_REWIND_MAX_STACKS) return false;
            seekRewindBurst.count += 1;
            seekRewindBurst.lastAt = now;
            return true;
        };

        const brakeFastForward = (player) => {
            if (seekFastForward.player !== player) return false;
            seekFastForwardStop('brake');
            resetSeekRewindBurst();
            return true;
        };

        // While a fast-forward scan is running, repeated seeks must add to the
        // pending target instead of the moving playhead, otherwise each wheel
        // notch / key press would only add a fraction of its step.
        const seekForwardBase = (player) => {
            if (seekFastForward.player === player) return seekFastForward.target;
            return player.currentTime();
        };

        const seekFastForwardTo = (player, target, discrete = true) => {
            if (!player || player.isDisposed()) return false;
            const duration = player.duration();
            if (!isFinite(duration) || duration <= 0) return false;
            target = Math.max(0, Math.min(target, duration - 0.15));
            const current = player.currentTime();
            const delta = target - current;
            if (delta > 0) resetSeekRewindBurst();

            // Already scanning: extend the target, or hand back to a direct seek.
            if (seekFastForward.player === player) {
                if (delta <= 0.15) {
                    seekFastForwardStop('cancel');
                    return false;
                }
                if (discrete) {
                    if (seekFastForward.stacks >= SEEK_FF_MAX_STACKS ||
                        target - seekFastForward.startTime > SEEK_FF_MAX_EXTEND_SECONDS) {
                        return 'capped';
                    }
                    seekFastForward.stacks += 1;
                } else if (target - seekFastForward.startTime > SEEK_FF_MAX_EXTEND_SECONDS) {
                    seekFastForwardStop('cancel');
                    return false;
                }
                seekFastForward.target = target;
                const rate = Math.max(SEEK_FF_MIN_RATE, Math.min(SEEK_FF_MAX_RATE,
                    delta / (SEEK_FF_TARGET_MS / 1000)));
                try {
                    if (Math.abs(player.playbackRate() - rate) > 0.4) player.playbackRate(rate);
                } catch (e) {}
                return true;
            }

            if (player.paused() || player.ended()) return false;
            if (delta < SEEK_FF_MIN_SECONDS || delta > SEEK_FF_MAX_SECONDS) return false;
            if (!isForwardBuffered(player, target)) return false;

            seekFastForward.player = player;
            seekFastForward.target = target;
            seekFastForward.startTime = current;
            seekFastForward.stacks = 1;
            seekFastForward.savedRate = player.playbackRate() || 1;
            seekHint.total = 0;
            seekHint.lastAt = 0;

            const rate = Math.max(SEEK_FF_MIN_RATE, Math.min(SEEK_FF_MAX_RATE,
                delta / (SEEK_FF_TARGET_MS / 1000)));
            try { player.playbackRate(rate); } catch (e) {}

            const onPause = () => {
                if (seekFastForward.player === player) seekFastForwardStop('pause');
            };
            const onEnded = () => {
                if (seekFastForward.player === player) seekFastForwardStop('ended');
            };
            seekFastForward.onPause = onPause;
            seekFastForward.onEnded = onEnded;
            player.on('pause', onPause);
            player.on('ended', onEnded);

            const startedAt = performance.now();
            const tick = () => {
                if (seekFastForward.player !== player) return;
                if (player.isDisposed() || player.ended()) { seekFastForwardStop('ended'); return; }
                if (player.currentTime() >= seekFastForward.target - 0.05) {
                    seekFastForwardStop('reached');
                    return;
                }
                if (performance.now() - startedAt > SEEK_FF_TIMEOUT_MS) {
                    seekFastForwardStop('timeout');
                    return;
                }
                seekFastForward.raf = requestAnimationFrame(tick);
            };
            seekFastForward.raf = requestAnimationFrame(tick);
            seekFastForward.timer = setTimeout(() => seekFastForwardStop('timeout'), SEEK_FF_TIMEOUT_MS);
            return true;
        };

        // Seek feedback takes over the remaining-time countdown next to the
        // progress bar, showing "+5s" / "−5s" while a seek is triggered. If
        // that countdown is hidden (very small layouts), fall back to a small
        // floating badge above the progress bar.
        const seekHint = {
            el: null,
            badge: null,
            total: 0,
            timer: 0,
            lastAt: 0,
        };

        const clearSeekHint = () => {
            seekHint.total = 0;
            if (seekHint.el) {
                seekHint.el.classList.remove('is-seek-hint');
                seekHint.el.removeAttribute('data-seek-hint');
                seekHint.el = null;
            }
            if (seekHint.badge) {
                seekHint.badge.classList.remove('is-visible');
                seekHint.badge = null;
            }
        };

        const showSeekHint = (player, seconds, hold) => {
            if (!player || player.isDisposed() || !seconds) return false;
            const now = performance.now();
            if (seekFastForward.player === player) {
                // While a scan runs, show the real distance from where the scan
                // started (summing per-command steps would overstate a drag).
                seekHint.total = seekFastForward.target - seekFastForward.startTime;
            } else {
                const sameSign = (seekHint.total > 0) === (seconds > 0);
                if (sameSign && now - seekHint.lastAt < 900) seekHint.total += seconds;
                else seekHint.total = seconds;
            }
            if (!seekHint.total) {
                clearSeekHint();
                return true;
            }
            // Ignore single tiny deltas (progress-bar drag emits many); keep
            // accumulating until the change is worth showing.
            if (Math.abs(seekHint.total) < 0.3) return true;

            const absTotal = Math.abs(seekHint.total);
            const shownTotal = absTotal >= 10 ? Math.round(absTotal) : Math.round(absTotal * 10) / 10;
            const text = (seekHint.total > 0 ? '+' : '\u2212') + shownTotal + 's';
            const controlBar = player.getChild && player.getChild('controlBar');
            if (!controlBar) return false;

            // Preferred: reuse the remaining-time countdown's slot.
            const remaining = controlBar.getChild && controlBar.getChild('remainingTimeDisplay');
            const remainingEl = remaining && remaining.el && remaining.el();
            const canUseRemaining = remainingEl && remainingEl.getClientRects().length > 0;

            if (seekHint.badge) {
                seekHint.badge.classList.remove('is-visible');
                seekHint.badge = null;
            }
            if (seekHint.el && seekHint.el !== remainingEl) {
                seekHint.el.classList.remove('is-seek-hint');
                seekHint.el.removeAttribute('data-seek-hint');
                seekHint.el = null;
            }

            if (canUseRemaining) {
                seekHint.el = remainingEl;
                seekHint.el.classList.add('is-seek-hint');
                seekHint.el.setAttribute('data-seek-hint', text);
            } else {
                const progress = controlBar.getChild && controlBar.getChild('progressControl');
                const host = progress && progress.el && progress.el();
                if (!host) return false;
                let badge = host.querySelector('.vjs-seek-hint');
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'vjs-seek-hint';
                    host.appendChild(badge);
                }
                badge.textContent = text;
                badge.classList.add('is-visible');
                seekHint.badge = badge;
            }

            try { player.userActive(true); } catch (e) {}
            seekHint.lastAt = now;
            if (seekHint.timer) { clearTimeout(seekHint.timer); seekHint.timer = 0; }
            if (!hold) {
                seekHint.timer = setTimeout(() => {
                    seekHint.timer = 0;
                    clearSeekHint();
                }, 750);
            }
            return true;
        };

        const releaseSeekHint = (delay = 260) => {
            if (seekHint.timer) { clearTimeout(seekHint.timer); seekHint.timer = 0; }
            seekHint.timer = setTimeout(() => {
                seekHint.timer = 0;
                clearSeekHint();
            }, delay);
        };

        const folderCache = new Map();
        const listScrollCache = new Map();

        const playlistSnapshots = new Map();

        const fileListCache = new Map();
        const fileListInFlight = new Map();
        const FILE_LIST_TTL = 3000;

        const normalizeFolderUri = (u) => {
            let s = String(u || '').split('?')[0].split('#')[0];
            if (!s.startsWith('/')) s = '/' + s;
            s = s.replace(/\/+/g, '/');
            if (!s.endsWith('/')) s += '/';
            try { s = decodeURI(s); } catch {}
            return s;
        };

        const getNativeFolderList = (folderUri) => {
            const st = window.HFS && window.HFS.state;
            if (!st || st.loading || !Array.isArray(st.list)) return null;
            if (normalizeFolderUri(st.uri || '') !== normalizeFolderUri(folderUri)) return null;
            return st.list;
        };

        const waitForNativeFolderList = (folderUri, timeout = 1200) => {
            const st = window.HFS && window.HFS.state;
            if (!st) return Promise.resolve(null);
            if (normalizeFolderUri(st.uri || '') !== normalizeFolderUri(folderUri)) return Promise.resolve(null);
            if (!st.loading && Array.isArray(st.list)) return Promise.resolve(st.list);
            if (!window.HFS || typeof window.HFS.watchState !== 'function') return Promise.resolve(null);

            return new Promise(resolve => {
                let done = false;
                let off = null;
                let timer = null;
                const finish = value => {
                    if (done) return;
                    done = true;
                    if (timer) clearTimeout(timer);
                    try { off && off(); } catch {}
                    resolve(value);
                };
                const check = () => {
                    const s = window.HFS && window.HFS.state;
                    if (!s || normalizeFolderUri(s.uri || '') !== normalizeFolderUri(folderUri)) return finish(null);
                    if (s.loading) return;
                    if (Array.isArray(s.list)) finish(s.list);
                };
                try { off = window.HFS.watchState('loading', check, false); } catch {}
                timer = setTimeout(() => finish(null), timeout);
                check();
            });
        };

        const loopStateByUrl = new Map();

        // HLS library loader. It is only needed when server transcoding falls
        // back to HLS (?ffmpeg=hls); load it on demand instead of on every page.
        let hlsLoadingPromise = null;
        const loadHlsLib = () => {
            if (window.Hls) return Promise.resolve(window.Hls);
            if (hlsLoadingPromise) return hlsLoadingPromise;
            const url = PLUGIN_PUBLIC_URL + 'hls.light.min.js';
            hlsLoadingPromise = HFS.loadScript(url).then(() => {
                if (!window.Hls) throw new Error('HLS library failed to load');
                return window.Hls;
            }).catch(err => {
                hlsLoadingPromise = null;
                throw err;
            });
            return hlsLoadingPromise;
        };

        // Preload it only when transcoding is enabled; otherwise hls.js is never
        // used (there is no direct m3u8 playback path in this plugin).
        if (C.enable_ffmpeg_transcoding) {
            loadHlsLib().catch(() => {});
        }

        // ============================================================
        // === Playback Memory Guard ===
        // ============================================================
        const PLAYBACK_CSS_ID = 'vjs-playback-active-style';
        const PLAYBACK_ROOT_CLASS = 'vjs-playback-active';
        const DIR_SELECTOR = '.dir';
        const THUMB_SELECTOR = 'img.thumbnail';

        const playbackMemoryGuard = (() => {
            let active = false;
            let scrollIO = null;
            let scrollMO = null;

            function injectStyle() {
                if (document.getElementById(PLAYBACK_CSS_ID)) return;
                const st = document.createElement('style');
                st.id = PLAYBACK_CSS_ID;
                st.textContent = `
html.${PLAYBACK_ROOT_CLASS},
html.${PLAYBACK_ROOT_CLASS} * {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    box-shadow: none !important;
}
`;
                document.head.appendChild(st);
            }

            function getRootMargin() {
                try {
                    const cfg = HFS.getPluginConfig ? HFS.getPluginConfig() : null;
                    if (cfg && cfg.scrollRootMargin != null) {
                        const n = Number(cfg.scrollRootMargin);
                        if (!isNaN(n) && n >= 0) return `${n}px 0px`;
                    }
                } catch (e) {}
                return '100px 0px';
            }

            function isDirThumb(img) {
                if (!img || img.tagName !== 'IMG') return false;
                if (!img.matches(THUMB_SELECTOR)) return false;
                if (!img.closest(DIR_SELECTOR)) return false;
                const src = img.getAttribute('src') || img.dataset.scrollOriginalSrc || '';
                if (!src || src.startsWith('data:')) return false;
                return true;
            }

            function suspend(img) {
                if (!isDirThumb(img)) return;
                const src = img.getAttribute('src');
                if (src && !src.startsWith('data:')) {
                    if (!img.dataset.scrollOriginalSrc) img.dataset.scrollOriginalSrc = src;
                    img.removeAttribute('src');
                }
                try { img.onload = null; img.onerror = null; } catch (e) {}
                img.dataset.scrollSuspended = '1';
                img.classList.add('scroll-suspended');
            }

            function resume(img) {
                if (active) return;
                if (!img.dataset.scrollSuspended) return;
                delete img.dataset.scrollSuspended;
                img.classList.remove('scroll-suspended');
                const original = img.dataset.scrollOriginalSrc;
                if (original && !img.classList.contains('thumbnail-suspended')) {
                    delete img.dataset.fadeProcessed;
                    img.style.opacity = '';
                    img.setAttribute('src', original);
                }
            }

            function buildIO() {
                if (scrollIO) scrollIO.disconnect();
                scrollIO = new IntersectionObserver((entries) => {
                    for (const e of entries) {
                        const img = e.target;
                        if (!isDirThumb(img)) continue;
                        if (active) { suspend(img); continue; }
                        // Stop-images-on-navigate 有統一的嚴格視口管控（含尺寸/方向變動）時，
                        // 清單縮略圖交給它裁決，避免兩套 rootMargin 互相把圖復活。
                        if (window.__hfsThumbGate && window.__hfsThumbGate.version) continue;
                        if (e.isIntersecting) resume(img);
                        else suspend(img);
                    }
                }, { root: null, rootMargin: getRootMargin(), threshold: 0 });
            }

            function observeAll() {
                if (!scrollIO) return;
                document.querySelectorAll(`${DIR_SELECTOR} ${THUMB_SELECTOR}`).forEach(img => {
                    if (isDirThumb(img)) {
                        if (active) suspend(img);
                        scrollIO.observe(img);
                    }
                });
            }

            function startMO() {
                if (scrollMO) return;
                scrollMO = new MutationObserver((muts) => {
                    for (const m of muts) {
                        for (const node of m.addedNodes) {
                            if (node.nodeType !== 1) continue;
                            if (node.matches && node.matches(THUMB_SELECTOR) && node.closest(DIR_SELECTOR)) {
                                if (isDirThumb(node) && scrollIO) {
                                    if (active) suspend(node);
                                    scrollIO.observe(node);
                                }
                            }
                            if (node.querySelectorAll && scrollIO) {
                                node.querySelectorAll(THUMB_SELECTOR).forEach(img => {
                                    if (img.closest(DIR_SELECTOR) && isDirThumb(img)) {
                                        if (active) suspend(img);
                                        scrollIO.observe(img);
                                    }
                                });
                            }
                        }
                    }
                });
                scrollMO.observe(document.body, { childList: true, subtree: true });
            }

            function suspendAllThumbs() {
                document.querySelectorAll(`${DIR_SELECTOR} ${THUMB_SELECTOR}`).forEach(img => {
                    if (isDirThumb(img)) suspend(img);
                });
            }

            function enter() {
                if (active) return;
                active = true;
                injectStyle();
                document.documentElement.classList.add(PLAYBACK_ROOT_CLASS);
                if (scrollIO) { scrollIO.disconnect(); scrollIO = null; }
                suspendAllThumbs();
                // 播放 / file-show 期間由本插件接管：連 Stop-images-on-navigate 也暫停恢復
                const gate = window.__hfsThumbGate;
                if (gate && gate.setHold) gate.setHold(true);
            }

            function exit() {
                if (!active) return;
                active = false;
                document.documentElement.classList.remove(PLAYBACK_ROOT_CLASS);
                setTimeout(() => {
                    if (active) return;
                    buildIO();
                    observeAll();
                    const gate = window.__hfsThumbGate;
                    if (gate && gate.setHold) gate.setHold(false);
                }, 300);
            }

            function boot() {
                injectStyle();
                buildIO();
                startMO();
                setTimeout(observeAll, 500);
                try {
                    if (HFS.watchState) {
                        HFS.watchState('uri', () => {
                            if (active) return;
                            buildIO();
                            setTimeout(observeAll, 200);
                        }, true);
                    }
                } catch (e) {}
            }

            return {
                boot,
                enter,
                exit,
                isActive: () => active,
            };
        })();

        playbackMemoryGuard.boot();

        let fileShowCloseObserver = null;

        const ensureFileShowCloseObserver = () => {
            if (fileShowCloseObserver) return;

            let hadFileShow = document.querySelectorAll('.file-show').length > 0;
            if (hadFileShow) {
                playbackMemoryGuard.enter();
            }

            fileShowCloseObserver = new MutationObserver(() => {
                const has = document.querySelectorAll('.file-show').length > 0;

                if (hadFileShow !== has) {
                    if (has) {
                        playbackMemoryGuard.enter();
                    } else {
                        playbackMemoryGuard.exit();
                        if (playlistSnapshots.size > 0) {
                            playlistSnapshots.clear();
                        }
                    }
                }
                hadFileShow = has;
            });

            fileShowCloseObserver.observe(document.body, { childList: true, subtree: true });
        };

        // ============================================================
        // === 内置 HFS File-Show 菜单操作 ===
        // ============================================================
        const MENU_BUTTON_SELECTOR = [
            '.dialog-backdrop.file-show button[title="Menu"]',
            '.dialog-backdrop.file-show button[aria-label="Menu"]',
            '.dialog-backdrop.file-show button:has(.fa-menu)',
            '.dialog-backdrop.file-dialog button[title="Menu"]',
            '.dialog-backdrop.file-dialog button[aria-label="Menu"]',
            '.dialog-backdrop.file-dialog button:has(.fa-menu)',
        ].join(', ');

        const ITEM_SELECTOR_PREFIX = '#menu-entry-';
        const MENU_CONTAINER_SELECTOR = '.file-menu';
        const FILE_DIALOG_SELECTOR = '.dialog-backdrop.file-dialog';

        let hiddenFileDialog = null;
        let subDialogObserver = null;

        function getMenuItem(action) {
            return document.querySelector(`${ITEM_SELECTOR_PREFIX}${action}`);
        }

        function getMenuButton() {
            const direct = document.querySelector(MENU_BUTTON_SELECTOR);
            if (direct) return direct;

            const candidates = document.querySelectorAll(
                '.dialog-backdrop.file-show button, .dialog-backdrop.file-dialog button'
            );
            for (const btn of candidates) {
                const label = (
                    btn.getAttribute('title') ||
                    btn.getAttribute('aria-label') ||
                    ''
                );
                if (/menu/i.test(label)) return btn;
                if (btn.querySelector('.fa-menu')) return btn;
            }
            return null;
        }

        function isMenuOpen() {
            return !!document.querySelector(MENU_CONTAINER_SELECTOR);
        }

        function getAllMenuContainers() {
            return Array.from(document.querySelectorAll(MENU_CONTAINER_SELECTOR));
        }

        function getFileDialog() {
            return document.querySelector(FILE_DIALOG_SELECTOR);
        }

        function hasSubDialog() {
            return !!document.querySelector(
                '.dialog-backdrop.dialog-prompt:not([style*="display: none"]), ' +
                '.dialog-backdrop.dialog-alert:not([style*="display: none"]), ' +
                '.dialog-backdrop.dialog-confirm:not([style*="display: none"])'
            );
        }

        function hideFileDialog() {
            const dialog = getFileDialog();
            if (!dialog) return;
            if (hiddenFileDialog && hiddenFileDialog !== dialog) {
                hiddenFileDialog.style.display = '';
            }
            hiddenFileDialog = dialog;
            dialog.style.display = 'none';
        }

        function restoreFileDialog() {
            if (!hiddenFileDialog) return;
            hiddenFileDialog.style.display = '';
            hiddenFileDialog = null;
        }

        function ensureSubDialogObserver() {
            if (subDialogObserver) return;
            subDialogObserver = new MutationObserver(() => {
                if (hiddenFileDialog && !hasSubDialog()) {
                    restoreFileDialog();
                }
            });
            subDialogObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'hidden', 'class'],
            });
        }

        function closeAllMenus() {
            const menus = getAllMenuContainers();
            if (menus.length === 0) return false;

            const closer = document.querySelector(
                '.dialog-backdrop.file-show .dialog-closer, ' +
                '.dialog-backdrop.file-dialog .dialog-closer'
            );
            if (closer) closer.click();

            const remaining = getAllMenuContainers();
            if (remaining.length > 1) {
                remaining.slice(1).forEach((menu) => menu.remove());
            }
            return true;
        }

        function clickMenuButton(options = {}) {
            const { toggle = true } = options;

            if (isMenuOpen()) {
                if (toggle) {
                    closeAllMenus();
                    return true;
                }
                closeAllMenus();
            }

            const button = getMenuButton();
            if (!button) return false;

            button.click();
            return true;
        }

        function waitForMenuItem(action, timeoutMs = 1500, intervalMs = 50) {
            return new Promise((resolve) => {
                const startedAt = Date.now();
                function check() {
                    const item = getMenuItem(action);
                    if (item) return resolve(item);
                    if (Date.now() - startedAt >= timeoutMs) return resolve(null);
                    setTimeout(check, intervalMs);
                }
                check();
            });
        }

        async function clickFileMenuItem(action, options = {}) {
            const {
                openMenuIfNeeded = true,
                timeoutMs = 1500,
                intervalMs = 50,
            } = options;

            let item = getMenuItem(action);

            if (item) {
                item.click();
                if (action === 'comment') {
                    requestAnimationFrame(() => {
                        if (hasSubDialog()) hideFileDialog();
                        else requestAnimationFrame(() => {
                            if (hasSubDialog()) hideFileDialog();
                        });
                    });
                }
                return true;
            }

            if (!openMenuIfNeeded) return false;

            closeAllMenus();

            if (!clickMenuButton({ toggle: false })) return false;

            item = await waitForMenuItem(action, timeoutMs, intervalMs);
            if (!item) return false;

            item.click();

            if (action === 'comment') {
                requestAnimationFrame(() => {
                    if (hasSubDialog()) hideFileDialog();
                    else requestAnimationFrame(() => {
                        if (hasSubDialog()) hideFileDialog();
                    });
                });
            }
            return true;
        }

        ensureSubDialogObserver();
        ensureFileShowCloseObserver();

        // When the HFS Close button is pressed, silence the media immediately
        // instead of waiting for the dialog's unmount cleanup. This keeps the
        // close responsive for native MKV playback, whose teardown can stall.
        const silenceMediaForFileShowClose = (event) => {
            const target = event.target;
            if (!target || !target.closest) return;
            const closeBtn = target.closest('.file-show .bar button[title="Close"]');
            if (!closeBtn) return;
            const dialog = closeBtn.closest('.file-show');
            if (!dialog) return;
            dialog.querySelectorAll('video').forEach(v => {
                try {
                    v.pause();
                    v.muted = true;
                } catch (e) {}
            });
        };
        document.addEventListener('pointerdown', silenceMediaForFileShowClose, true);
        document.addEventListener('click', silenceMediaForFileShowClose, true);

        // ============================================================
        // === Helper: 中文数字解析 ===
        // ============================================================
const parseChineseNum = (str) => {
    if (str == null) return null;
    str = String(str).trim();
    if (/^\d+$/.test(str)) return parseInt(str, 10);

    const digitMap = {
        '零': 0, '〇': 0,
        '一': 1, '壹': 1,
        '二': 2, '贰': 2, '两': 2,
        '三': 3, '叁': 3,
        '四': 4, '肆': 4,
        '五': 5, '伍': 5,
        '六': 6, '陆': 6,
        '七': 7, '柒': 7,
        '八': 8, '捌': 8,
        '九': 9, '玖': 9,
    };
    const unitMap = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 };

    if (str.length === 1 && digitMap[str] !== undefined) return digitMap[str];

    let total = 0;
    let section = 0;
    let currentDigit = 0;
    let lastWasUnit = false;
    let hasAny = false;

    for (const ch of str) {
        if (digitMap[ch] !== undefined) {
            currentDigit = digitMap[ch];
            lastWasUnit = false;
            hasAny = true;
        } else if (unitMap[ch] !== undefined) {
            const unit = unitMap[ch];
            if (currentDigit === 0 && !lastWasUnit) currentDigit = 1;
            section += currentDigit * unit;
            currentDigit = 0;
            lastWasUnit = true;
            hasAny = true;
        } else {
            return null;
        }
    }
    if (currentDigit > 0 || section > 0) total = section + currentDigit;
    if (!hasAny) return null;
    return total;
};

const pad2 = (n) => String(n).padStart(2, '0');

const extractEpisode = (name) => {
    if (!name) return null;
    const base = name.replace(/\.[^.]+$/, '');
    const CN = '[0-9零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+';

    let m = base.match(/s\s*(\d+)\s*e\s*(\d+)/i);
    if (m) {
        return 'S' + pad2(parseInt(m[1], 10)) + 'E' + pad2(parseInt(m[2], 10));
    }

    m = base.match(
        new RegExp('第?\\s*(' + CN + ')\\s*季\\s*(?:第\\s*)?(' + CN + ')\\s*集')
    );
    if (m) {
        const s = parseChineseNum(m[1]);
        const e = parseChineseNum(m[2]);
        if (s !== null && e !== null) {
            return 'S' + pad2(s) + 'E' + pad2(e);
        }
    }

    m = base.match(new RegExp('第?\\s*(' + CN + ')\\s*集'));
    if (m) {
        const e = parseChineseNum(m[1]);
        if (e !== null) return 'E' + pad2(e);
    }

    m = base.match(new RegExp('第?\\s*(' + CN + ')\\s*[话話]'));
    if (m) {
        const e = parseChineseNum(m[1]);
        if (e !== null) return 'E' + pad2(e);
    }

m = base.match(new RegExp('第\\s*(' + CN + ')\\s*期'));
if (m) {
    const p = parseChineseNum(m[1]);
    if (p !== null) return 'P-' + pad2(p);
}

m = base.match(new RegExp('第\\s*(' + CN + ')\\s*(部|章|节|節|篇|卷|回)'));
if (m) {
    const p = parseChineseNum(m[1]);
    if (p !== null) return 'P-' + pad2(p);
}

m = base.match(/(\d+)\s*(部|章|节|節|篇|卷|回)/);
if (m) return 'P-' + pad2(+m[1]);

    m = base.match(/part\s*(\d+)/i);
    if (m) return 'P-' + pad2(parseInt(m[1], 10));

    return null;
};

const extractNumberTokens = (name) => {
    if (!name) return [];
    const base = name.replace(/\.[^.]+$/, '');

    const tokens = [];
    const seenRanges = [];

    const overlaps = (start, end) => seenRanges.some(([s, e]) => start < e && end > s);

    {
        const re = /s(\d+)\s*e(\d+)/gi;
        let m;
        while ((m = re.exec(base))) {
            if (overlaps(m.index, m.index + m[0].length)) continue;
            tokens.push({ idx: m.index, order: tokens.length, val: parseInt(m[1], 10) });
            tokens.push({ idx: m.index, order: tokens.length, val: parseInt(m[2], 10) });
            seenRanges.push([m.index, m.index + m[0].length]);
        }
    }

    {
        const re = /第\s*([0-9零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+)\s*(季|集|话|話|章|部|卷|回|期|篇|节|節)/g;
        let m;
        while ((m = re.exec(base))) {
            if (overlaps(m.index, m.index + m[0].length)) continue;
            const n = parseChineseNum(m[1]);
            if (n !== null) {
                tokens.push({ idx: m.index, order: tokens.length, val: n });
                seenRanges.push([m.index, m.index + m[0].length]);
            }
        }
    }

    {
        const re = /(\d+|[一二两三四五六七八九十]+)\s*季\s*(\d+|[一二两三四五六七八九十]+)\s*集/g;
        let m;
        while ((m = re.exec(base))) {
            if (overlaps(m.index, m.index + m[0].length)) continue;
            const s = parseChineseNum(m[1]);
            const e = parseChineseNum(m[2]);
            if (s !== null && e !== null) {
                tokens.push({ idx: m.index, order: tokens.length, val: s });
                tokens.push({ idx: m.index, order: tokens.length, val: e });
                seenRanges.push([m.index, m.index + m[0].length]);
            }
        }
    }

    {
        const re = /\d+/g;
        let m;
        while ((m = re.exec(base))) {
            if (overlaps(m.index, m.index + m[0].length)) continue;
            tokens.push({ idx: m.index, order: tokens.length, val: parseInt(m[0], 10) });
            seenRanges.push([m.index, m.index + m[0].length]);
        }
    }

    tokens.sort((a, b) => (a.idx - b.idx) || (a.order - b.order));
    return tokens.map(t => t.val);
};

        const extractDateToken = (name) => {
            if (!name) return null;
            const base = name.replace(/\.[^.]+$/, '');
            let m = base.match(/(?:^|[^\d])(\d{6})(?:[^\d]|$)/);
            if (m) {
                const s = m[1];
                const yy = parseInt(s.slice(0, 2), 10);
                const mm = parseInt(s.slice(2, 4), 10);
                const dd = parseInt(s.slice(4, 6), 10);
                if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return yy * 10000 + mm * 100 + dd;
            }
            m = base.match(/(?:^|[^\d])(\d{8})(?:[^\d]|$)/);
            if (m) {
                const s = m[1];
                const yyyy = parseInt(s.slice(0, 4), 10);
                const mm = parseInt(s.slice(4, 6), 10);
                const dd = parseInt(s.slice(6, 8), 10);
                if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return yyyy * 10000 + mm * 100 + dd;
            }
            m = base.match(/(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})/);
            if (m) return parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10);
            return null;
        };

const extractGroupKey = (name) => {
    if (!name) return '';
    const base = name.replace(/\.[^.]+$/, '');

    let firstIdx = -1;

    const consider = (idx) => {
        if (idx < 0) return;
        if (firstIdx < 0 || idx < firstIdx) firstIdx = idx;
    };

    {
        const m = base.match(/s\d+\s*e\d+/i);
        if (m) consider(m.index);
    }

    {
        const m = base.match(/第\s*[0-9零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+\s*(季|集|话|話|章|部|卷|回|期|篇|节|節)/);
        if (m) consider(m.index);
    }

    {
        const m = base.match(/[0-9一二两三四五六七八九十]+\s*季\s*[0-9一二两三四五六七八九十]+\s*集/);
        if (m) consider(m.index);
    }

    {
        const m = base.match(/\d+/);
        if (m) consider(m.index);
    }

    {
        const m = base.match(/part\s*\d+/i);
        if (m) consider(m.index);
    }

    if (firstIdx < 0) return base.trim();
    return base.substring(0, firstIdx).trim();
};

const compareByNumbersThenDate = (a, b) => {
    const ga = extractGroupKey(a.name);
    const gb = extractGroupKey(b.name);
    if (ga !== gb) {
        const cmp = ga.localeCompare(gb, undefined, { numeric: false, sensitivity: 'base' });
        if (cmp !== 0) return cmp;
    }

    const na = extractNumberTokens(a.name);
    const nb = extractNumberTokens(b.name);
    const len = Math.min(na.length, nb.length);
    for (let i = 0; i < len; i++) {
        if (na[i] !== nb[i]) return na[i] - nb[i];
    }
    if (na.length !== nb.length) return na.length - nb.length;

    const da = extractDateToken(a.name);
    const db = extractDateToken(b.name);
    if (da !== null && db !== null && da !== db) return da - db;
    if (da !== null && db === null) return -1;
    if (da === null && db !== null) return 1;

    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
};

        function determineMimeType(src) {
            if (src.startsWith('blob:') || src.startsWith('data:')) return 'video/mp4';
            const cleanSrc = src.split('?')[0];
            const ext = cleanSrc.substring(cleanSrc.lastIndexOf('.')).toLowerCase();
            if (ext === '.webm') return 'video/webm';
            if (ext === '.ogv' || ext === '.ogg') return 'video/ogg';
            if (C.enableHLS) {
                if (ext === '.mkv') return 'video/x-matroska';
                if (ext === '.m3u8') return 'application/x-mpegURL';
            }
            return 'video/mp4';
        }

        // Chrome can play some Matroska files (H.264/AAC) but fails on HEVC,
        // E-AC3, DTS, … and some of those failures can hang the renderer instead
        // of firing a clean media error. When server transcoding is off, peek
        // at the Matroska header and refuse the file up front if its codecs
        // cannot be decoded, so Chrome never starts the problematic pipeline.
        const MKV_PROBE_BYTES = 262144;
        const mkvSupportCache = new Map();

        const canPlayTypeSafe = (type) => {
            try {
                return !!document.createElement('video').canPlayType(type);
            } catch (e) {
                return false;
            }
        };

        const probeMkvSupport = (src) => {
            let url;
            try { url = new URL(src, location.href); } catch (e) { return Promise.resolve(null); }
            if (!/\.mkv$/i.test(url.pathname)) return Promise.resolve(null);
            const key = url.pathname;
            if (mkvSupportCache.has(key)) return mkvSupportCache.get(key);

            const probe = (async () => {
                let res;
                try {
                    res = await fetch(url.href, {
                        headers: { Range: `bytes=0-${MKV_PROBE_BYTES - 1}` },
                        cache: 'no-store',
                        credentials: 'same-origin',
                    });
                } catch (e) {
                    return null;
                }
                if (!res.ok) {
                    try { res.body && res.body.cancel(); } catch (e) {}
                    return null;
                }
                if (res.status !== 206) {
                    // Range not supported: do not pull a multi-GB file just to probe.
                    try { res.body && res.body.cancel(); } catch (e) {}
                    return null;
                }
                let bytes;
                try {
                    bytes = new Uint8Array(await res.arrayBuffer());
                } catch (e) {
                    return null;
                }
                const text = new TextDecoder('latin1').decode(bytes);

                const videoCodecs = [
                    ['V_MPEGH/ISO/HEVC', 'HEVC (H.265)', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
                    ['V_MPEG4/ISO/AVC', 'H.264', 'video/mp4; codecs="avc1.42E01E"'],
                    ['V_MPEG4/ISO/ASP', 'MPEG-4 Part 2', null],
                    ['V_MPEG2', 'MPEG-2', null],
                    ['V_AV1', 'AV1', 'video/mp4; codecs="av01.0.05M.08"'],
                    ['V_VP9', 'VP9', 'video/webm; codecs="vp9"'],
                    ['V_VP8', 'VP8', 'video/webm; codecs="vp8"'],
                    ['V_THEORA', 'Theora', null],
                ];
                const audioCodecs = [
                    ['A_AAC', 'AAC', 'audio/mp4; codecs="mp4a.40.2"'],
                    ['A_AC3', 'AC-3', 'audio/mp4; codecs="ac-3"'],
                    ['A_EAC3', 'E-AC3', 'audio/mp4; codecs="ec-3"'],
                    ['A_DTS', 'DTS', null],
                    ['A_TRUEHD', 'Dolby TrueHD', null],
                    ['A_FLAC', 'FLAC', 'audio/mp4; codecs="flac"'],
                    ['A_OPUS', 'Opus', 'audio/webm; codecs="opus"'],
                    ['A_VORBIS', 'Vorbis', 'audio/webm; codecs="vorbis"'],
                    ['A_MPEG/L3', 'MP3', 'audio/mpeg'],
                    ['A_PCM', 'PCM', 'audio/wav'],
                ];

                const findCodec = (list) => {
                    for (const entry of list) {
                        if (text.indexOf(entry[0]) !== -1) return entry;
                    }
                    return null;
                };

                const unsupported = [];
                const video = findCodec(videoCodecs);
                if (video) {
                    const [, label, mime] = video;
                    if (!mime || !canPlayTypeSafe(mime)) unsupported.push(label);
                }
                const audio = findCodec(audioCodecs);
                if (audio) {
                    const [, label, mime] = audio;
                    if (!mime || !canPlayTypeSafe(mime)) unsupported.push(label);
                }
                return unsupported.length
                    ? { blocked: true, codec: unsupported.join(' + ') }
                    : { blocked: false };
            })().catch(() => null);

            mkvSupportCache.set(key, probe);
            probe.then(result => {
                if (!result) mkvSupportCache.delete(key);
            });
            return probe;
        };

        const hardBrakeVideo = (videoEl) => {
            if (!videoEl) return;
            try {
                videoEl.pause();
                const sources = videoEl.querySelectorAll('source');
                sources.forEach(s => s.remove());
                videoEl.removeAttribute('src');
                // One load is enough to abort the current resource; the old
                // double load() could stall for a moment on native MKV demuxers.
                videoEl.load();
            } catch (e) {
                console.warn('[VideoJS] hardBrakeVideo failed:', e);
            }
        };

        const releasePlayer = (player, videoEl) => {
            if (!player || player.isDisposed()) return;
            try {
                player.pause();
            } catch (e) {}
            try {
                const el = videoEl
                    || (player.el() && player.el().querySelector('video.video-js, video.vjs-tech, .video-js video'));
                hardBrakeVideo(el);
            } catch (e) {
                console.warn('[VideoJS] releasePlayer hardBrake failed:', e);
            }
            try {
                player.reset();
                player.error(null);
            } catch (e) {
                console.warn('[VideoJS] releasePlayer reset failed:', e);
            }
        };

        const transferRef = {
            player: null,
            videoEl: null,
            dialogEl: null,
            transcoding: false,
        };

        const interruptCurrentTransfer = (reason = 'unknown') => {
            const { player, videoEl, dialogEl } = transferRef;

            if (player && !player.isDisposed()) {
                releasePlayer(player, videoEl);
            } else if (videoEl) {
                hardBrakeVideo(videoEl);
            }

            if (dialogEl && dialogEl.parentNode) {
                dialogEl.querySelectorAll('video').forEach(v => hardBrakeVideo(v));
            }

            transferRef.transcoding = false;
        };

        const formatSize = (bytes) => {
            if (bytes == null || isNaN(bytes)) return '';
            if (bytes < 1024) return bytes + ' B';
            const units = ['KB', 'MB', 'GB', 'TB'];
            let v = bytes / 1024;
            let i = 0;
            while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
            return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
        };

        const formatBitrate = (bitsPerSec) => {
            if (!bitsPerSec || isNaN(bitsPerSec) || bitsPerSec <= 0) return '';
            const kbps = bitsPerSec / 1000;
            if (kbps >= 1000) {
                const mbps = kbps / 1000;
                return (mbps >= 10 ? mbps.toFixed(0) : mbps.toFixed(1)) + ' Mbps';
            }
            return Math.round(kbps) + ' kbps';
        };

        const formatTs = (ts) => {
            if (ts == null || isNaN(ts)) return '';
            const d = new Date(ts);
            if (isNaN(d.getTime())) return '';
            const p = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        };

        const getFolderUri = (src) => {
            if (!src) return '';
            const clean = src.split('?')[0].split('#')[0];
            const lastSlash = clean.lastIndexOf('/');
            return lastSlash >= 0 ? clean.substring(0, lastSlash + 1) : '';
        };

        const syncHfsFileShowBar = (item) => {
            if (!item) return;
            try {
                const bar = document.querySelector('.file-show .bar');
                if (!bar) return;
                const filenameEl = bar.querySelector('.filename');
                if (filenameEl) {
                    const folderSpan = filenameEl.querySelector('.folder');
                    [...filenameEl.childNodes].forEach(n => {
                        if (n !== folderSpan) filenameEl.removeChild(n);
                    });
                    filenameEl.appendChild(document.createTextNode(item.name || ''));
                }
                const sizeEl = bar.querySelector('.entry-size');
                if (sizeEl && item.size != null) sizeEl.textContent = formatSize(item.size);
                const tsEl = bar.querySelector('.entry-ts');
                if (tsEl && item.mtime != null) tsEl.textContent = formatTs(item.mtime);
            } catch (e) {
                console.warn('[VideoJS] syncHfsFileShowBar failed:', e);
            }
        };

        const findHfsEntryByName = (name) => {
            const list = (window.HFS && window.HFS.state && window.HFS.state.list) || [];
            for (const e of list) {
                const n = e && (e.n || e.name);
                if (n === name) return e;
            }
            return null;
        };

        const getWrapper = (player) => {
            if (!player || player.isDisposed()) return null;
            const el = player.el();
            return el && el.closest ? el.closest('.vjs-player-wrapper') : null;
        };

        const requestWrapperFullscreen = (player) => {
            const wrapper = getWrapper(player);
            if (!wrapper) return;
            try {
                if (wrapper.requestFullscreen) {
                    wrapper.requestFullscreen().catch(e => console.warn('[VideoJS] wrapper fullscreen failed:', e));
                } else if (wrapper.webkitRequestFullscreen) {
                    wrapper.webkitRequestFullscreen();
                }
            } catch (e) {
                console.warn('[VideoJS] requestWrapperFullscreen error:', e);
            }
        };

        const exitWrapperFullscreen = () => {
            try {
                if (document.exitFullscreen && document.fullscreenElement) {
                    document.exitFullscreen().catch(() => {});
                } else if (document.webkitExitFullscreen && document.webkitFullscreenElement) {
                    document.webkitExitFullscreen();
                }
            } catch (e) {}
        };

        const isWrapperFullscreen = () => {
            const wrapper = document.querySelector('.vjs-player-wrapper');
            if (!wrapper) return false;
            return (
                document.fullscreenElement === wrapper ||
                document.webkitFullscreenElement === wrapper ||
                document.mozFullScreenElement === wrapper ||
                document.msFullscreenElement === wrapper
            );
        };

        const stopVideosIn = (dialogEl) => {
            if (!dialogEl) return;
            try {
                dialogEl.querySelectorAll('video').forEach(v => {
                    try { v.muted = true; } catch (e) {}
                    hardBrakeVideo(v);
                });
            } catch (e) {
                console.warn('[VideoJS] stopVideosIn failed:', e);
            }
        };

        const closeWithFade = (dialogEl, delay = 180, fade = 220) => {
            if (!dialogEl || !dialogEl.parentNode) return;
            setTimeout(() => {
                if (!dialogEl.parentNode) return;
                dialogEl.classList.add('vjs-closing');
                setTimeout(() => {
                    if (!dialogEl.parentNode) return;
                    const closeBtn = dialogEl.querySelector('.bar button[title="Close"]')
                        || dialogEl.querySelector('.bar button.icon-only:last-child');
                    if (closeBtn) closeBtn.click();
                    else if (dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl);
                }, fade);
            }, delay);
        };

        // HFS pushes one history entry for every file-show dialog it opens.
        // The playlist opens a new dialog whenever it switches item, so every
        // jump leaves a stale dialog entry behind. On refresh the in-memory
        // dialog stack is empty while those history entries still carry a
        // dialog id, so HFS walks back through them and can end up on an
        // earlier page instead of the folder currently being played.
        // Swap that single pushState for replaceState: the dialog keeps one
        // history entry, the older entry is reused, and refreshing always
        // returns to the folder that is playing.
        let fileShowHistoryPatch = null;
        const restoreFileShowHistory = () => {
            const patch = fileShowHistoryPatch;
            if (!patch) return;
            fileShowHistoryPatch = null;
            if (patch.timer) clearTimeout(patch.timer);
            if (window.history.pushState === patch.wrapped) {
                window.history.pushState = patch.originalPush;
            }
        };

        const openHfsFileShowReplacingHistory = (entry) => {
            const h = window.history;
            if (!h || typeof h.pushState !== 'function' || fileShowHistoryPatch) {
                HFS.fileShow(entry, { startPlaying: false });
                return;
            }

            const originalPush = h.pushState;
            const wrappedPush = function (state, title, url) {
                restoreFileShowHistory();
                try {
                    return h.replaceState(state, title, url || location.href);
                } catch (e) {
                    return originalPush.call(h, state, title, url);
                }
            };

            const patch = { originalPush, wrapped: wrappedPush, timer: null };
            fileShowHistoryPatch = patch;
            patch.timer = setTimeout(restoreFileShowHistory, 1500);
            h.pushState = wrappedPush;

            try {
                HFS.fileShow(entry, { startPlaying: false });
            } catch (e) {
                restoreFileShowHistory();
                throw e;
            }
        };

        const isVideoName = (name) => {
            if (!name) return false;
            const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
            return VIDEO_EXTS.includes(ext)
                || (C.enableHLS && (ext === '.m3u8' || ext === '.mkv'));
        };

        const toPlaylistTimestamp = (v) => {
            if (!v) return null;
            const t = Date.parse(v);
            return isNaN(t) ? null : t;
        };

        const entryToPlaylistItem = (it, folderUri) => {
            const name = it && (it.n || it.name);
            if (!name || !isVideoName(name)) return null;
            return {
                name,
                url: folderUri + name,
                size: (it.s !== undefined && it.s !== null) ? it.s : (it.size !== undefined ? it.size : null),
                mtime: toPlaylistTimestamp(it.m),
                comment: (it.comment !== undefined && it.comment !== null && String(it.comment).trim() !== '')
                    ? String(it.comment)
                    : null,
                episode: extractEpisode(name),
            };
        };

        const fetchFileListFor = async (folderUri, force = false) => {
            const native = await waitForNativeFolderList(folderUri);
            if (native) return native;

            const key = normalizeFolderUri(folderUri);
            if (!force) {
                const cached = fileListCache.get(key);
                if (cached && Date.now() - cached.ts < FILE_LIST_TTL) return cached.list;
            }
            if (fileListInFlight.has(key)) return fileListInFlight.get(key);

            const request = (async () => {
                const apiUrl = `/~/api/get_file_list?uri=${encodeURIComponent(folderUri)}`;
                const res = await fetch(apiUrl, {
                    credentials: 'same-origin',
                    headers: { 'Accept': 'application/json' },
                    cache: 'no-store'
                });
                if (!res.ok) throw new Error('get_file_list ' + res.status);
                const data = await res.json();
                const list = data && data.list ? data.list : [];
                fileListCache.set(key, { list, ts: Date.now() });
                return list;
            })();

            fileListInFlight.set(key, request);
            try {
                return await request;
            } finally {
                if (fileListInFlight.get(key) === request) fileListInFlight.delete(key);
            }
        };

        const fetchFolderVideos = async (src, forceRefresh = false) => {
            const clean = src.split('?')[0];
            const lastSlash = clean.lastIndexOf('/');
            const folderUri = lastSlash >= 0 ? clean.substring(0, lastSlash + 1) : '';
            if (!folderUri) return [];

            if (forceRefresh) {
                folderCache.delete(folderUri);
            }

            if (!forceRefresh && folderCache.has(folderUri)) {
                return folderCache.get(folderUri);
            }

            try {
                const list = await fetchFileListFor(folderUri, forceRefresh);
                const items = list
                    .map(it => entryToPlaylistItem(it, folderUri))
                    .filter(Boolean);
                folderCache.set(folderUri, items);
                return items;
            } catch (e) {
                console.warn('[VideoJS] fetchFolderVideos failed:', e);
                return folderCache.get(folderUri) || [];
            }
        };

        const getCurrentFilename = (player, fallbackSrc) => {
            try {
                if (player && !player.isDisposed()) {
                    const cs = player.currentSrc();
                    if (cs) {
                        const clean = decodeURIComponent(cs.split('?')[0].split('#')[0]);
                        const name = clean.split('/').pop();
                        if (name) return name;
                    }
                }
            } catch {}
            if (fallbackSrc) {
                const clean = decodeURIComponent(fallbackSrc.split('?')[0].split('#')[0]);
                return clean.split('/').pop();
            }
            return '';
        };

        const readPlaylistOpenState = (defaultOpen) => {
            try {
                const saved = localStorage.getItem('vjs-playlist-open');
                if (saved === '1') return true;
                if (saved === '0') return false;
            } catch {}
            return !!defaultOpen;
        };

        const writePlaylistOpenState = (open) => {
            try { localStorage.setItem('vjs-playlist-open', open ? '1' : '0'); } catch {}
        };

        // Vertical split between the video and the playlist in portrait mode.
        const PLAYLIST_RATIO_DEFAULT = 0.4;
        const PLAYLIST_RATIO_MIN = 0.12;
        const PLAYLIST_RATIO_MAX = 0.85;

        const readPlaylistRatio = () => {
            try {
                const v = parseFloat(localStorage.getItem('vjs-playlist-ratio'));
                if (isFinite(v) && v >= PLAYLIST_RATIO_MIN && v <= PLAYLIST_RATIO_MAX) return v;
            } catch {}
            return PLAYLIST_RATIO_DEFAULT;
        };

        const writePlaylistRatio = (ratio) => {
            try { localStorage.setItem('vjs-playlist-ratio', String(ratio)); } catch {}
        };

        // Landscape split between the video and the right-hand playlist.
        // The chosen width is stored in CSS pixels so resizing the window (or
        // changing the page scale) no longer stretches the playlist.
        const PLAYLIST_WIDTH_MIN = 0.10;
        const PLAYLIST_WIDTH_MAX = 0.70;
        const PLAYLIST_WIDTH_PX_KEY = 'vjs-playlist-width-px';
        const PLAYLIST_WIDTH_LEGACY_KEY = 'vjs-playlist-width';

        const readPlaylistWidthPx = () => {
            try {
                const v = parseFloat(localStorage.getItem(PLAYLIST_WIDTH_PX_KEY));
                if (isFinite(v) && v >= 80 && v <= 4000) return v;
            } catch {}
            return null; // no saved width: keep the CSS default (250px / 25%)
        };

        const writePlaylistWidthPx = (px) => {
            try { localStorage.setItem(PLAYLIST_WIDTH_PX_KEY, String(px)); } catch {}
        };

        // Old versions stored a 0.10–0.70 ratio; convert it once using the
        // current wrapper width, then keep using pixels from then on.
        const readPlaylistWidthLegacyRatio = () => {
            try {
                const v = parseFloat(localStorage.getItem(PLAYLIST_WIDTH_LEGACY_KEY));
                if (isFinite(v) && v >= PLAYLIST_WIDTH_MIN && v <= PLAYLIST_WIDTH_MAX) return v;
            } catch {}
            return null;
        };

        // Last applied pixel sizes (module scope: survives the player remount when
        // switching videos). A remount reuses them when they are still close, so
        // the playlist does not jump when the video area settles.
        let lastPortraitPlaylistHeight = 0;
        let lastLandscapePlaylistWidth = 0;

        const getCurrentFileShowName = () => {
            const bar = document.querySelector(
                '.dialog-backdrop.file-show .bar .filename, ' +
                '.dialog-backdrop.file-dialog .filename'
            );
            if (!bar) return '';

            const folder = bar.querySelector('.folder');
            let text = '';
            bar.childNodes.forEach((n) => {
                if (n !== folder && n.nodeType === 3) {
                    text += n.textContent;
                }
            });
            return text.trim();
        };

        const isCurrentFileShow = (item) => {
            if (!item || !item.name) return false;
            return getCurrentFileShowName() === item.name;
        };

        const triggerCommentForItem = async (item) => {
            if (!isCurrentFileShow(item)) return false;
            try {
                const ok = await clickFileMenuItem('comment');
                if (!ok) console.warn('[VideoJS] Built-in comment trigger failed.');
                return ok;
            } catch (e) {
                console.warn('[VideoJS] Built-in comment trigger error:', e);
                return false;
            }
        };

        const getCurrentBitrate = (player, items) => {
            if (!player || player.isDisposed()) return 0;

            try {
                const ql = player.qualityLevels && player.qualityLevels();
                if (ql && ql.length) {
                    const idx = ql.selectedIndex;
                    const level = idx >= 0 ? ql[idx] : null;
                    if (level && level.bitrate > 0) return level.bitrate;
                }
            } catch (e) {}

            try {
                const curSrc = player.currentSrc() || '';
                if (/[?&]ffmpeg\b/.test(curSrc)) return 0;
                const dur = player.duration();
                if (!dur || !isFinite(dur) || dur <= 1) return 0;
                const name = getCurrentFilename(player);
                if (!name) return 0;
                let size = null;
                const list = items || [];
                const it = list.find(x => x.name === name);
                if (it && it.size) size = it.size;
                if (!size) {
                    const entry = findHfsEntryByName(name);
                    if (entry) size = entry.s != null ? entry.s : (entry.size != null ? entry.size : null);
                }
                if (!size) return 0;
                return (size / dur) * 8;
            } catch (e) {
                return 0;
            }
        };

        const deriveItemsFromLock = (lock) => {
            if (!lock) return [];
            const out = [];
            for (const name of lock.order) {
                const it = lock.map[name];
                if (it) out.push(it);
            }
            return out;
        };

        const patchLockFromHfsState = (folderUri, lock) => {
            if (!lock) return false;
            const st = window.HFS && window.HFS.state;
            if (!st || st.loading || !Array.isArray(st.list)) return false;
            if (normalizeFolderUri(st.uri || '') !== normalizeFolderUri(folderUri)) return false;
            const hfsList = st.list;

            const hfsByName = new Map();
            hfsList.forEach(e => {
                const n = e && (e.n || e.name);
                if (n && isVideoName(n)) hfsByName.set(n, e);
            });

            let changed = false;
            const nextOrder = [];
            for (const name of lock.order) {
                if (hfsByName.has(name)) {
                    nextOrder.push(name);
                    const entry = hfsByName.get(name);
                    const cur = lock.map[name];
                    if (cur) {
                        const newComment = (entry.comment !== undefined && entry.comment !== null && String(entry.comment).trim() !== '')
                            ? String(entry.comment) : null;
                        const newSize = (entry.s !== undefined && entry.s !== null) ? entry.s : cur.size;
                        if (newComment !== cur.comment || newSize !== cur.size) {
                            lock.map[name] = { ...cur, comment: newComment, size: newSize };
                            changed = true;
                        }
                    }
                } else {
                    delete lock.map[name];
                    changed = true;
                }
            }

            const seen = new Set(nextOrder);
            for (const entry of hfsList) {
                const n = entry && (entry.n || entry.name);
                if (!n || !isVideoName(n) || seen.has(n)) continue;
                const item = entryToPlaylistItem(entry, folderUri);
                if (!item) continue;
                lock.map[n] = item;
                nextOrder.push(n);
                seen.add(n);
                changed = true;
            }

            if (nextOrder.length !== lock.order.length || nextOrder.some((n, i) => n !== lock.order[i])) {
                lock.order = nextOrder;
                changed = true;
            }
            if (changed) {
                playlistSnapshots.set(folderUri, lock);
            }
            return changed;
        };

        const refreshSnapshotFromServer = async (folderUri) => {
            if (!folderUri) return;
            const lock = playlistSnapshots.get(folderUri);
            if (!lock) return;

            try {
                const list = await fetchFileListFor(folderUri, true);

                const byName = new Map();
                list.forEach(it => {
                    const n = it && (it.n || it.name);
                    if (n && isVideoName(n)) byName.set(n, it);
                });

                let changed = false;

                const nextOrder = [];
                for (const name of lock.order) {
                    if (byName.has(name)) {
                        nextOrder.push(name);
                        const entry = byName.get(name);
                        const cur = lock.map[name];
                        if (cur) {
                            const newComment = (entry.comment !== undefined && entry.comment !== null && String(entry.comment).trim() !== '')
                                ? String(entry.comment) : null;
                            const newSize = (entry.s !== undefined && entry.s !== null) ? entry.s : cur.size;
                            if (newComment !== cur.comment || newSize !== cur.size) {
                                lock.map[name] = { ...cur, comment: newComment, size: newSize };
                                changed = true;
                            }
                        }
                    } else {
                        delete lock.map[name];
                        changed = true;
                    }
                }
                if (nextOrder.length !== lock.order.length) {
                    lock.order = nextOrder;
                    changed = true;
                }

                if (changed) {
                    playlistSnapshots.set(folderUri, lock);
                }
                window.dispatchEvent(new CustomEvent('vjs-playlist-refresh', { detail: { folderUri } }));
            } catch (e) {
                console.warn('[VideoJS] refreshSnapshotFromServer failed:', e);
            }
        };

        const getCurrentFileShowFolderUri = () => {
            const vid = document.querySelector('.file-show video.video-js, .file-show video.vjs-tech, .file-show video');
            if (vid) {
                const src = vid.currentSrc || vid.src || '';
                if (src) return getFolderUri(src);
            }
            if (window.HFS && window.HFS.state && window.HFS.state.uri) {
                const u = window.HFS.state.uri;
                return u.endsWith('/') ? u : u + '/';
            }
            return '';
        };

        let dialogCloseObserver = null;
        let playlistHfsSyncTimer = 0;
        const syncCurrentPlaylistFromHfs = (delay = 60) => {
            if (playlistHfsSyncTimer) clearTimeout(playlistHfsSyncTimer);
            playlistHfsSyncTimer = setTimeout(() => {
                playlistHfsSyncTimer = 0;
                const fu = getCurrentFileShowFolderUri();
                if (!fu) return;
                const lock = playlistSnapshots.get(fu);
                if (!lock) return;
                if (patchLockFromHfsState(fu, lock)) {
                    window.dispatchEvent(new CustomEvent('vjs-playlist-refresh', {
                        detail: { folderUri: fu },
                    }));
                }
            }, delay);
        };

        const ensureDialogCloseObserver = () => {
            if (dialogCloseObserver) return;

            const countActionDialogs = () => {
                let n = 0;
                document.querySelectorAll('.dialog[aria-modal="true"]').forEach(d => {
                    if (d.closest && d.closest('.file-show')) return;
                    if (d.querySelector('textarea[name="input"]')) { n++; return; }
                    if (d.querySelector('.dialog-content') && d.querySelectorAll('button').length >= 1) { n++; }
                });
                return n;
            };

            let hadActionDialog = countActionDialogs() > 0;

            dialogCloseObserver = new MutationObserver(() => {
                const nowHas = countActionDialogs() > 0;
                if (hadActionDialog && !nowHas) {
                    syncCurrentPlaylistFromHfs(150);
                }
                hadActionDialog = nowHas;
            });

            dialogCloseObserver.observe(document.body, { childList: true, subtree: true });
        };

        let hfsStateWatch = null;
        const ensureHfsStateWatch = () => {
            if (hfsStateWatch) return;
            let lastJson = '';

            const check = () => {
                const list = (window.HFS && window.HFS.state && window.HFS.state.list) || [];
                if (!list.length) return;
                const json = JSON.stringify(list.map(e => ({
                    n: e && (e.n || e.name),
                    c: (e && e.comment) || '',
                    s: e && e.s
                })));
                if (lastJson && json !== lastJson) {
                    syncCurrentPlaylistFromHfs(80);
                }
                lastJson = json;
            };

            check();
            hfsStateWatch = setInterval(check, 800);
        };

        const PlaylistPanel = ({ src, playerRef, open, portrait, onClose, controlsLocked, onToggleControlsLocked, onRegisterNav }) => {
            const [items, setItems] = React.useState(() => {
                const fu = getFolderUri(src);
                const lock = fu && playlistSnapshots.get(fu);
                if (lock) {
                    patchLockFromHfsState(fu, lock);
                    return deriveItemsFromLock(lock);
                }
                return fu && folderCache.has(fu) ? folderCache.get(fu) : [];
            });
            const [currentName, setCurrentName] = React.useState('');
            const [loading, setLoading] = React.useState(false);
            const [bitrate, setBitrate] = React.useState(0);
            const [loopCurrent, setLoopCurrent] = React.useState(() => {
                const fu = getFolderUri(src);
                const name = getCurrentFilename(playerRef && playerRef.current, src);
                const key = fu && name ? fu + name : '';
                return key ? !!loopStateByUrl.get(key) : false;
            });

            const readSortMode = () => {
                try {
                    return localStorage.getItem('vjs-playlist-sort') === 'num';
                } catch {
                    return false;
                }
            };
            const writeSortMode = (on) => {
                try { localStorage.setItem('vjs-playlist-sort', on ? 'num' : 'default'); } catch {}
            };

            const [forceNumericSort, setForceNumericSort] = React.useState(readSortMode);
            const [sortSwitching, setSortSwitching] = React.useState(false);
            const sortSwitchTimerRef = React.useRef(null);

            React.useEffect(() => {
                return () => {
                    if (sortSwitchTimerRef.current) clearTimeout(sortSwitchTimerRef.current);
                };
            }, []);

            const panelRef = React.useRef(null);
            const headerRef = React.useRef(null);
            const listRef = React.useRef(null);
            const currentItemRef = React.useRef(null);
            const lastAutoScrollKeyRef = React.useRef('');
            const autoAdvancingRef = React.useRef(false);
            const initSizeRef = React.useRef(false);

            // Apply the remembered split: playlist width in landscape, height in portrait.
            // useLayoutEffect + no-transition on the first run: switching videos remounts this
            // panel, and applying the saved size after paint used to make the whole playlist
            // animate/jitter on every switch.
            React.useLayoutEffect(() => {
                const panel = panelRef.current;
                if (!panel) return;
                const wrapper = panel.parentElement;
                if (!wrapper) return;

                const apply = (instant) => {
                    const firstRun = !initSizeRef.current;
                    initSizeRef.current = true;
                    if (!open) {
                        // clear inline sizes so the CSS transition can collapse the panel
                        panel.style.width = '';
                        panel.style.maxWidth = '';
                        panel.style.height = '';
                        panel.style.maxHeight = '';
                        return;
                    }
                    if (panel.classList.contains('is-resizing')) return;
                    const wr = wrapper.getBoundingClientRect();
                    if (!wr.width || !wr.height) return;
                    // first layout (mount) and window/orientation re-applies: jump, don't animate
                    const noTransition = firstRun || instant === true;
                    let transitionOff = false;
                    if (portrait) {
                        let next = Math.round(readPlaylistRatio() * wr.height);
                        if (firstRun && lastPortraitPlaylistHeight && Math.abs(next - lastPortraitPlaylistHeight) < 24) {
                            next = lastPortraitPlaylistHeight;
                        }
                        const cur = parseFloat(panel.style.height);
                        // ignore tiny reflows (e.g. the video area changing a few px after a switch)
                        if (!firstRun && isFinite(cur) && Math.abs(next - cur) < 24) return;
                        if (noTransition) { panel.classList.add('no-transition'); transitionOff = true; }
                        panel.style.width = '';
                        panel.style.maxWidth = '';
                        panel.style.height = next + 'px';
                        panel.style.maxHeight = 'none';
                        lastPortraitPlaylistHeight = next;
                    } else {
                        let savedPx = readPlaylistWidthPx();
                        if (savedPx == null) {
                            const legacyRatio = readPlaylistWidthLegacyRatio();
                            if (legacyRatio != null) {
                                savedPx = Math.round(legacyRatio * wr.width);
                                writePlaylistWidthPx(savedPx);
                                try { localStorage.removeItem(PLAYLIST_WIDTH_LEGACY_KEY); } catch (e) {}
                            }
                        }
                        if (savedPx == null) {
                            panel.style.width = '';
                            panel.style.maxWidth = '';
                        } else {
                            const minW = Math.max(140, wr.width * PLAYLIST_WIDTH_MIN);
                            const maxW = Math.max(minW, wr.width * PLAYLIST_WIDTH_MAX);
                            // Keep the user's pixel width; only clamp it when the
                            // current window is too narrow for it.
                            let next = Math.round(Math.min(maxW, Math.max(minW, savedPx)));
                            if (firstRun && lastLandscapePlaylistWidth && Math.abs(next - lastLandscapePlaylistWidth) < 24) {
                                next = lastLandscapePlaylistWidth;
                            }
                            const cur = parseFloat(panel.style.width);
                            if (!firstRun && isFinite(cur) && Math.abs(next - cur) < 24) return;
                            if (noTransition) { panel.classList.add('no-transition'); transitionOff = true; }
                            panel.style.height = '';
                            panel.style.maxHeight = '';
                            panel.style.width = next + 'px';
                            panel.style.maxWidth = 'none';
                            lastLandscapePlaylistWidth = next;
                        }
                    }
                    if (transitionOff) {
                        requestAnimationFrame(() => {
                            try { panel.classList.remove('no-transition'); } catch (e) {}
                        });
                    }
                };

                let lastOuterW = window.outerWidth;
                let lastOuterH = window.outerHeight;
                const onWindowChange = () => {
                    // Ignore internal layout-induced resize events (file-show re-layout,
                    // scrollbars after a video switch): only react to real window changes.
                    if (window.outerWidth === lastOuterW && window.outerHeight === lastOuterH) return;
                    lastOuterW = window.outerWidth;
                    lastOuterH = window.outerHeight;
                    apply(true);
                };
                apply();
                window.addEventListener('resize', onWindowChange);
                window.addEventListener('orientationchange', onWindowChange);
                return () => {
                    window.removeEventListener('resize', onWindowChange);
                    window.removeEventListener('orientationchange', onWindowChange);
                };
            }, [open, portrait]);

            // Divider handle: drag to resize (width in landscape, height in portrait).
            const resizeRef = React.useRef(null);

            const onHandlePointerDown = (event) => {
                if (event.button !== undefined && event.button !== 0) return;
                const panel = panelRef.current;
                const wrapper = panel && panel.parentElement;
                if (!panel || !wrapper) return;
                const panelRect = panel.getBoundingClientRect();
                const wrapperRect = wrapper.getBoundingClientRect();
                if (!panelRect.width || !panelRect.height || !wrapperRect.width || !wrapperRect.height) return;
                if (event.cancelable) event.preventDefault();
                event.stopPropagation();
                resizeRef.current = {
                    pointerId: event.pointerId,
                    portrait,
                    startX: event.clientX,
                    startY: event.clientY,
                    startW: panelRect.width,
                    startH: panelRect.height,
                    wrapperW: wrapperRect.width,
                    wrapperH: wrapperRect.height,
                    current: portrait ? panelRect.height : panelRect.width,
                };
                panel.classList.add('is-resizing');
                document.body.classList.add('vjs-playlist-resizing');
                try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
                try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (e) {}
            };

            const onHandlePointerMove = (event) => {
                const drag = resizeRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                const panel = panelRef.current;
                if (!panel) return;
                if (event.cancelable) event.preventDefault();
                if (drag.portrait) {
                    const minH = Math.max(110, drag.wrapperH * PLAYLIST_RATIO_MIN);
                    const maxH = Math.min(drag.wrapperH * PLAYLIST_RATIO_MAX, drag.wrapperH - 90);
                    const next = Math.min(maxH, Math.max(minH, drag.startH + (drag.startY - event.clientY)));
                    drag.current = next;
                    lastPortraitPlaylistHeight = Math.round(next);
                    panel.style.height = Math.round(next) + 'px';
                    panel.style.maxHeight = 'none';
                } else {
                    const minW = Math.max(140, drag.wrapperW * PLAYLIST_WIDTH_MIN);
                    const maxW = Math.max(minW, drag.wrapperW * PLAYLIST_WIDTH_MAX);
                    const next = Math.min(maxW, Math.max(minW, drag.startW + (drag.startX - event.clientX)));
                    drag.current = next;
                    lastLandscapePlaylistWidth = Math.round(next);
                    panel.style.width = Math.round(next) + 'px';
                    panel.style.maxWidth = 'none';
                }
            };

            const onHandlePointerUp = (event) => {
                const drag = resizeRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                resizeRef.current = null;
                const panel = panelRef.current;
                const wrapper = panel && panel.parentElement;
                if (panel) panel.classList.remove('is-resizing');
                document.body.classList.remove('vjs-playlist-resizing');
                if (!panel || !wrapper) return;
                const wrapperRect = wrapper.getBoundingClientRect();
                if (drag.portrait) {
                    const ratio = Math.min(PLAYLIST_RATIO_MAX, Math.max(PLAYLIST_RATIO_MIN, drag.current / drag.wrapperH));
                    writePlaylistRatio(ratio);
                    if (wrapperRect.height) {
                        lastPortraitPlaylistHeight = Math.round(ratio * wrapperRect.height);
                        panel.style.height = lastPortraitPlaylistHeight + 'px';
                        panel.style.maxHeight = 'none';
                    }
                } else {
                    const px = Math.round(drag.current);
                    writePlaylistWidthPx(px);
                    lastLandscapePlaylistWidth = px;
                    panel.style.width = px + 'px';
                    panel.style.maxWidth = 'none';
                }
            };


            const itemsRef = React.useRef(items);
            itemsRef.current = items;

            const sortedItems = React.useMemo(() => {
                if (!forceNumericSort) return items;
                return [...items].sort(compareByNumbersThenDate);
            }, [items, forceNumericSort]);
            const sortedItemsRef = React.useRef(sortedItems);
            sortedItemsRef.current = sortedItems;

            const syncScheduledRef = React.useRef(false);

            const gestureRef = React.useRef({
                timer: null,
                longPressed: false,
                startX: 0,
                startY: 0,
            });
            const LONG_PRESS_MS = 500;
            const MOVE_THRESHOLD = 10;

            const folderUri = getFolderUri(src);

            React.useEffect(() => {
                const onRefresh = (e) => {
                    if (!e.detail || e.detail.folderUri !== folderUri) return;
                    const lock = playlistSnapshots.get(folderUri);
                    if (lock) setItems(deriveItemsFromLock(lock));
                };
                window.addEventListener('vjs-playlist-refresh', onRefresh);
                return () => window.removeEventListener('vjs-playlist-refresh', onRefresh);
            }, [folderUri]);

            React.useEffect(() => {
                if (!folderUri) return;
                const lock = playlistSnapshots.get(folderUri);
                if (!lock) return;

                const apply = () => {
                    const changed = patchLockFromHfsState(folderUri, lock);
                    if (changed) setItems(deriveItemsFromLock(lock));
                };

                apply();
                const t1 = setTimeout(apply, 50);
                const t2 = setTimeout(apply, 200);
                return () => { clearTimeout(t1); clearTimeout(t2); };
            }, [folderUri, src]);

            React.useEffect(() => {
                if (!open) return;
                const player = playerRef.current;
                if (!player || player.isDisposed()) return;

                const updateBitrate = () => {
                    const b = getCurrentBitrate(player, itemsRef.current);
                    setBitrate(b > 0 ? b : 0);
                };

                updateBitrate();

                player.on('loadedmetadata', updateBitrate);
                player.on('durationchange', updateBitrate);
                player.on('sourceset', updateBitrate);
                player.on('loadstart', updateBitrate);

                let ql = null;
                const onQlChange = () => updateBitrate();
                try {
                    ql = player.qualityLevels && player.qualityLevels();
                } catch (e) {}
                if (ql && ql.addEventListener) {
                    ql.addEventListener('change', onQlChange);
                    ql.addEventListener('addqualitylevel', onQlChange);
                    ql.addEventListener('removequalitylevel', onQlChange);
                }

                return () => {
                    if (!player || player.isDisposed()) return;
                    player.off('loadedmetadata', updateBitrate);
                    player.off('durationchange', updateBitrate);
                    player.off('sourceset', updateBitrate);
                    player.off('loadstart', updateBitrate);
                    if (ql && ql.removeEventListener) {
                        ql.removeEventListener('change', onQlChange);
                        ql.removeEventListener('addqualitylevel', onQlChange);
                        ql.removeEventListener('removequalitylevel', onQlChange);
                    }
                };
            }, [open, src]);

            React.useEffect(() => {
                let cancelled = false;
                if (!folderUri) return;

                const lock = playlistSnapshots.get(folderUri);
                if (lock) {
                    setItems(deriveItemsFromLock(lock));
                    setLoading(false);
                    return;
                }

                if (folderCache.has(folderUri)) {
                    setItems(folderCache.get(folderUri));
                } else {
                    setLoading(true);
                }

                const timer = setTimeout(() => {
                    if (cancelled) return;
                    fetchFolderVideos(folderUri, true).then(list => {
                        if (cancelled) return;
                        if (!playlistSnapshots.has(folderUri)) {
                            const order = list.map(it => it.name);
                            const map = {};
                            list.forEach(it => { map[it.name] = it; });
                            playlistSnapshots.set(folderUri, { order, map });
                        }
                        setItems(deriveItemsFromLock(playlistSnapshots.get(folderUri)));
                        setLoading(false);
                    });
                }, 150);

                return () => {
                    cancelled = true;
                    clearTimeout(timer);
                };
            }, [folderUri]);

            React.useEffect(() => {
                if (!src) return;
                const name = getCurrentFilename(playerRef.current, src);
                if (name) setCurrentName(name);
            }, [src]);

            React.useEffect(() => {
                const player = playerRef && playerRef.current;
                if (!player || player.isDisposed()) return;

                const syncCurrent = () => {
                    const name = getCurrentFilename(player, src);
                    if (name) setCurrentName(name);
                    const fu = getFolderUri(src);
                    const key = fu && name ? fu + name : '';
                    if (key) setLoopCurrent(!!loopStateByUrl.get(key));
                    else setLoopCurrent(false);
                };

                player.on('loadstart', syncCurrent);
                player.on('sourceset', syncCurrent);
                player.on('loadedmetadata', syncCurrent);

                return () => {
                    if (!player || player.isDisposed()) return;
                    player.off('loadstart', syncCurrent);
                    player.off('sourceset', syncCurrent);
                    player.off('loadedmetadata', syncCurrent);
                };
            }, [src]);

            React.useEffect(() => {
                const player = playerRef && playerRef.current;
                if (!player || player.isDisposed()) return;

                const handleEnded = () => {
                    if (autoAdvancingRef.current) return;
                    if (!sortedItems.length) return;

                    const currentFilename = getCurrentFilename(player, src);
                    if (!currentFilename) return;

                    const idx = sortedItems.findIndex(it => it.name === currentFilename);
                    if (idx < 0) return;

                    const nextItem = sortedItems[(idx + 1) % sortedItems.length];
                    if (!nextItem) return;

                    autoAdvancingRef.current = true;
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            try {
                                handleSelectRef.current && handleSelectRef.current(nextItem, true);
                            } finally {
                                autoAdvancingRef.current = false;
                            }
                        });
                    });
                };

                player.on('ended', handleEnded);

                return () => {
                    if (!player || player.isDisposed()) return;
                    player.off('ended', handleEnded);
                };
            }, [sortedItems, src]);

            React.useLayoutEffect(() => {
                if (!open || !folderUri) return;
                if (sortSwitching) return;
                if (!sortedItems.length) return;

                const el = listRef.current;
                if (!el) return;

                const currentFilename = getCurrentFilename(playerRef.current, src);
                if (!currentFilename) return;

                const idx = sortedItems.findIndex(it => it.name === currentFilename);
                if (idx < 0) return;

                // Scroll only when the current video (or the sort order) changes;
                // plain list updates must not yank the view back from browsing.
                const scrollKey = `${folderUri}|${currentFilename}|${forceNumericSort ? 'n' : 'd'}`;
                if (lastAutoScrollKeyRef.current === scrollKey) return;

                const target = el.querySelectorAll('.vjs-playlist-item')[idx];
                if (target) {
                    // Keep the current item inside the list viewport without
                    // forcing it to the top: when switching to the next video,
                    // a row that is already visible must not jump.
                    const listRect = el.getBoundingClientRect();
                    const targetRect = target.getBoundingClientRect();
                    const pad = 6;
                    const above = targetRect.top < listRect.top + pad;
                    const below = targetRect.bottom > listRect.bottom - pad;
                    if (above || below) {
                        const prevBehavior = el.style.scrollBehavior;
                        el.style.scrollBehavior = 'auto';
                        if (above) {
                            el.scrollTop += targetRect.top - listRect.top - pad;
                        } else {
                            el.scrollTop += targetRect.bottom - listRect.bottom + pad;
                        }
                        el.style.scrollBehavior = prevBehavior;
                    }
                    lastAutoScrollKeyRef.current = scrollKey;
                }
            }, [open, folderUri, sortedItems, src, sortSwitching, forceNumericSort]);

            React.useEffect(() => {
                if (!open) {
                    lastAutoScrollKeyRef.current = '';
                }
            }, [open]);

            React.useEffect(() => {
                if (!open || !folderUri) return;
                const el = listRef.current;
                if (!el) return;
                const onScroll = () => {
                    listScrollCache.set(folderUri, el.scrollTop);
                };
                el.addEventListener('scroll', onScroll, { passive: true });
                return () => {
                    el.removeEventListener('scroll', onScroll);
                    listScrollCache.set(folderUri, el.scrollTop);
                };
            }, [open, folderUri]);

            React.useEffect(() => {
                if (!folderUri) return;

                const syncList = () => {
                    const lock = playlistSnapshots.get(folderUri);
                    if (!lock) return;

                    const st = window.HFS && window.HFS.state;
                    if (!st || st.loading || !Array.isArray(st.list)) return;
                    if (normalizeFolderUri(st.uri || '') !== normalizeFolderUri(folderUri)) return;
                    const hfsList = st.list;

                    const hfsByName = new Map();
                    hfsList.forEach(e => {
                        const n = e && (e.n || e.name);
                        if (n && isVideoName(n)) hfsByName.set(n, e);
                    });

                    const prevOrder = lock.order;
                    const nextOrder = [];
                    let removedAny = false;
                    let removedCurrent = false;
                    let changed = false;
                    const currentFilename = getCurrentFilename(playerRef.current, src);

                    for (const name of prevOrder) {
                        if (hfsByName.has(name)) {
                            nextOrder.push(name);
                            const entry = hfsByName.get(name);
                            const cur = lock.map[name];
                            if (cur) {
                                const newComment = (entry.comment !== undefined && entry.comment !== null && String(entry.comment).trim() !== '')
                                    ? String(entry.comment) : null;
                                const newSize = (entry.s !== undefined && entry.s !== null) ? entry.s : cur.size;
                                if (newComment !== cur.comment || newSize !== cur.size) {
                                    lock.map[name] = { ...cur, comment: newComment, size: newSize };
                                    changed = true;
                                }
                            }
                        } else {
                            removedAny = true;
                            if (name === currentFilename) removedCurrent = true;
                            delete lock.map[name];
                            changed = true;
                        }
                    }

                    const seen = new Set(nextOrder);
                    for (const entry of hfsList) {
                        const n = entry && (entry.n || entry.name);
                        if (!n || !isVideoName(n) || seen.has(n)) continue;
                        const item = entryToPlaylistItem(entry, folderUri);
                        if (!item) continue;
                        lock.map[n] = item;
                        nextOrder.push(n);
                        seen.add(n);
                        changed = true;
                    }

                    if (nextOrder.length !== prevOrder.length || nextOrder.some((n, i) => n !== prevOrder[i])) {
                        lock.order = nextOrder;
                        changed = true;
                    }

                    if (!changed) return;

                    playlistSnapshots.set(folderUri, lock);
                    setItems(deriveItemsFromLock(lock));

                    if (removedCurrent && !autoAdvancingRef.current) {
                        const player = playerRef.current;
                        if (player && !player.isDisposed() && currentFilename) {
                            releasePlayer(player);
                            const oldIdx = prevOrder.indexOf(currentFilename);
                            let nextItem = null;
                            for (let i = oldIdx + 1; i < prevOrder.length; i++) {
                                const nm = prevOrder[i];
                                if (lock.map[nm]) { nextItem = lock.map[nm]; break; }
                            }
                            if (!nextItem) {
                                for (let i = prevOrder.length - 1; i >= 0; i--) {
                                    const nm = prevOrder[i];
                                    if (lock.map[nm]) { nextItem = lock.map[nm]; break; }
                                }
                            }

                            if (nextItem) {
                                autoAdvancingRef.current = true;
                                requestAnimationFrame(() => requestAnimationFrame(() => {
                                    try {
                                        handleSelectRef.current && handleSelectRef.current(nextItem);
                                    } finally {
                                        autoAdvancingRef.current = false;
                                    }
                                }));
                            } else {
                                setCurrentName('');
                            }
                        }
                    }
                };

                const scheduleSync = () => {
                    if (syncScheduledRef.current) return;
                    syncScheduledRef.current = true;
                    requestAnimationFrame(() => {
                        syncScheduledRef.current = false;
                        syncList();
                    });
                };

                scheduleSync();

                let observer = null;
                const listEl = document.querySelector('.list');
                if (listEl) {
                    observer = new MutationObserver(scheduleSync);
                    observer.observe(listEl, { childList: true, subtree: true, characterData: true });
                }

                const interval = setInterval(scheduleSync, 2500);

                return () => {
                    if (observer) observer.disconnect();
                    clearInterval(interval);
                };
            }, [folderUri]);

            const handleSelectRef = React.useRef(null);

            const switchingRef = React.useRef(false);

            const applyLoopToPlayer = (player, item, forcePlay = false) => {
                if (!player || player.isDisposed()) return;
                const fu = getFolderUri(src);
                const name = item && item.name ? item.name : getCurrentFilename(player, src);
                const key = fu && name ? fu + name : '';
                const loopOn = key ? !!loopStateByUrl.get(key) : false;
                try { player.loop(loopOn); } catch (e) {}
                setLoopCurrent(loopOn);
            };

            const toggleLoopCurrent = (e) => {
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                const player = playerRef && playerRef.current;
                const fu = getFolderUri(src);
                const name = getCurrentFilename(player, src);
                const key = fu && name ? fu + name : '';
                if (!key) return;
                const next = !loopStateByUrl.get(key);
                if (next) loopStateByUrl.set(key, true);
                else loopStateByUrl.delete(key);
                if (player && !player.isDisposed()) {
                    try { player.loop(next); } catch (err) {}
                }
                setLoopCurrent(next);
            };

            const handleSelect = (item, forcePlay = false) => {
                const player = playerRef && playerRef.current;
                if (!player || player.isDisposed()) return;

                const playerSrc = (() => {
                    try { return decodeURI(player.currentSrc().split('?')[0]); } catch { return ''; }
                })();
                if (decodeURI(item.url) === playerSrc) return;

                if (switchingRef.current) {
                    transferRef.player = player;
                    transferRef.videoEl = player.el()
                        ? player.el().querySelector('video.video-js, video.vjs-tech, .video-js video')
                        : null;
                    interruptCurrentTransfer('rapid-click');
                    return;
                }
                switchingRef.current = true;

                const wasPlaying = forcePlay || !player.paused();

                transferRef.player = player;
                transferRef.videoEl = player.el()
                    ? player.el().querySelector('video.video-js, video.vjs-tech, .video-js video')
                    : null;
                transferRef.dialogEl = null;
                interruptCurrentTransfer('playlist-select');

                const fu = getFolderUri(src);
                const key = fu && item.name ? fu + item.name : '';
                const loopOn = key ? !!loopStateByUrl.get(key) : false;

                if (isWrapperFullscreen()) {
                    player.src({ src: item.url, type: determineMimeType(item.url) });
                    try { player.loop(loopOn); } catch (e) {}
                    setLoopCurrent(loopOn);
                    if (wasPlaying) {
                        const p = player.play();
                        if (p && p.catch) p.catch(() => {});
                    }
                    syncHfsFileShowBar(item);
                    setCurrentName(item.name);
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        setTimeout(() => { switchingRef.current = false; }, 300);
                    }));
                    return;
                }

                const entry = findHfsEntryByName(item.name);
                if (!entry || typeof HFS.fileShow !== 'function') {
                    player.src({ src: item.url, type: determineMimeType(item.url) });
                    try { player.loop(loopOn); } catch (e) {}
                    setLoopCurrent(loopOn);
                    if (wasPlaying) {
                        const p = player.play();
                        if (p && p.catch) p.catch(() => {});
                    }
                    syncHfsFileShowBar(item);
                    setCurrentName(item.name);
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        setTimeout(() => { switchingRef.current = false; }, 300);
                    }));
                    return;
                }

                const oldDialogs = Array.from(document.querySelectorAll('.file-show'));
                oldDialogs.forEach(stopVideosIn);

                try {
                    openHfsFileShowReplacingHistory(entry);
                } catch (e) {
                    console.warn('[VideoJS] HFS.fileShow threw:', e);
                    player.src({ src: item.url, type: determineMimeType(item.url) });
                    try { player.loop(loopOn); } catch (err) {}
                    setLoopCurrent(loopOn);
                    if (wasPlaying) {
                        const p = player.play();
                        if (p && p.catch) p.catch(() => {});
                    }
                    syncHfsFileShowBar(item);
                    setCurrentName(item.name);
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        setTimeout(() => { switchingRef.current = false; }, 300);
                    }));
                    return;
                }

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const all = Array.from(document.querySelectorAll('.file-show'));
                        const newest = all[all.length - 1];

                        transferRef.dialogEl = newest || null;

                        oldDialogs.forEach(d => {
                            if (d !== newest && d.parentNode) closeWithFade(d, 180, 220);
                        });

                        if (newest) {
                            const newVideoEl = newest.querySelector('video.video-js, video.vjs-tech, .video-js video');
                            if (newVideoEl) {
                                const newPlayer = videojs.getPlayer(newVideoEl);
                                if (newPlayer && !newPlayer.isDisposed()) {
                                    transferRef.player = newPlayer;
                                    transferRef.videoEl = newVideoEl;
                                    try { newPlayer.loop(loopOn); } catch (e) {}
                                    if (wasPlaying) {
                                        const playPromise = newPlayer.play();
                                        if (playPromise && playPromise.catch) playPromise.catch(() => {});
                                    }
                                }
                            }
                        }

                        setTimeout(() => { switchingRef.current = false; }, 300);
                    });
                });
            };

            handleSelectRef.current = handleSelect;

            React.useEffect(() => {
                if (!onRegisterNav) return;
                onRegisterNav({
                    canNavigate: () => sortedItemsRef.current.length > 0,
                    goPrev: () => {
                        const player = playerRef && playerRef.current;
                        if (!player || player.isDisposed()) return false;
                        const list = sortedItemsRef.current;
                        if (!list.length) return false;
                        const currentFilename = getCurrentFilename(player, src);
                        const idx = list.findIndex(it => it.name === currentFilename);
                        if (idx < 0) return false;
                        const prevItem = list[(idx - 1 + list.length) % list.length];
                        if (!prevItem) return false;
                        handleSelect(prevItem, true);
                        return true;
                    },
                    goNext: () => {
                        const player = playerRef && playerRef.current;
                        if (!player || player.isDisposed()) return false;
                        const list = sortedItemsRef.current;
                        if (!list.length) return false;
                        const currentFilename = getCurrentFilename(player, src);
                        const idx = list.findIndex(it => it.name === currentFilename);
                        if (idx < 0) return false;
                        const nextItem = list[(idx + 1) % list.length];
                        if (!nextItem) return false;
                        handleSelect(nextItem, true);
                        return true;
                    },
                });
            }, [sortedItems, src, onRegisterNav]);

            const clearGestureTimer = () => {
                if (gestureRef.current.timer) {
                    clearTimeout(gestureRef.current.timer);
                    gestureRef.current.timer = null;
                }
            };

            const startLongPressTimer = (item) => {
                clearGestureTimer();
                gestureRef.current.longPressed = false;
                gestureRef.current.timer = setTimeout(() => {
                    gestureRef.current.timer = null;
                    gestureRef.current.longPressed = true;

                    if (isCurrentFileShow(item)) {
                        triggerCommentForItem(item);
                    }
                }, LONG_PRESS_MS);
            };

            const onItemPointerDown = (item, e) => {
                gestureRef.current.startX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
                gestureRef.current.startY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
                startLongPressTimer(item);
            };

            const onItemPointerMove = (e) => {
                if (!gestureRef.current.timer) return;
                const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
                const y = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
                const dx = Math.abs(x - gestureRef.current.startX);
                const dy = Math.abs(y - gestureRef.current.startY);
                if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
                    clearGestureTimer();
                }
            };

            const onItemPointerUp = () => {
                clearGestureTimer();
                gestureRef.current.longPressed = false;
            };

            const onItemDoubleClick = (item, e) => {
                e.preventDefault();
                e.stopPropagation();

                if (isCurrentFileShow(item)) {
                    triggerCommentForItem(item);
                }
            };

            const currentIndex = (() => {
                if (!sortedItems.length || !currentName) return 0;
                const idx = sortedItems.findIndex(it => it.name === currentName);
                return idx >= 0 ? idx + 1 : 0;
            })();
            const countLabel = currentIndex > 0
                ? `${sortedItems.length}/${currentIndex}`
                : `${sortedItems.length}`;

            const handleToggleSort = () => {
                if (sortSwitching) return;
                setSortSwitching(true);
                requestAnimationFrame(() => {
                    setForceNumericSort(prev => {
                        const next = !prev;
                        writeSortMode(next);
                        return next;
                    });
                    if (sortSwitchTimerRef.current) clearTimeout(sortSwitchTimerRef.current);
                    sortSwitchTimerRef.current = setTimeout(() => {
                        setSortSwitching(false);
                        sortSwitchTimerRef.current = null;
                    }, 260);
                });
            };

            return h('div', {
                className: 'vjs-playlist' + (open ? ' is-open' : ''),
                ref: panelRef,
            }, [
                open && h('div', {
                    key: 'handle',
                    className: 'vjs-playlist-handle',
                    title: 'Drag to resize',
                    'aria-label': 'Drag to resize',
                    onPointerDown: onHandlePointerDown,
                    onPointerMove: onHandlePointerMove,
                    onPointerUp: onHandlePointerUp,
                    onPointerCancel: onHandlePointerUp,
                }),
                h('div', { className: 'vjs-playlist-header', key: 'header', ref: headerRef }, [
                    h('div', { className: 'vjs-playlist-header-left', key: 'left' }, [
                        h('span', {
                            className: 'vjs-playlist-title' + (sortSwitching ? ' is-switching' : ''),
                            title: forceNumericSort ? 'Switch to default order' : 'Sort by numbers / date',
                            style: { cursor: 'pointer', userSelect: 'none' },
                            onClick: handleToggleSort,
                        }, loading
                            ? '※\uFE0E Loading…'
                            : [
                                h('span', {
                                    key: 'icon',
                                    className: 'vjs-playlist-title-icon' + (forceNumericSort ? ' is-numeric' : ''),
                                }, forceNumericSort ? '|||' : '☰\uFE0E'),
                                h('span', { key: 'text', className: 'vjs-playlist-title-text' }, ' Playlist'),
                            ]),
                        h('span', { className: 'vjs-playlist-count' }, countLabel),
                    ]),
                    h('div', { className: 'vjs-playlist-header-right', key: 'right' }, [
                        bitrate > 0 && h('span', {
                            className: 'vjs-playlist-bitrate',
                            title: 'Bitrate',
                        }, formatBitrate(bitrate)),
                        h('button', {
                            className: 'vjs-playlist-btn vjs-playlist-lock' + (controlsLocked ? ' is-locked' : ''),
                            title: controlsLocked ? 'Unlock Controls' : 'Lock Controls',
                            onMouseDown: (e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                onToggleControlsLocked();
                            },
                            onTouchEnd: (e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                onToggleControlsLocked();
                            },
                        }, controlsLocked ? '▲\uFE0E' : '△\uFE0E'),
                        h('button', {
                            className: 'vjs-playlist-btn vjs-playlist-collapse',
                            title: 'Hide',
                            onMouseDown: (e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                onClose();
                            },
                            onTouchEnd: (e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                onClose();
                            },
                        }, '◢\uFE0E'),
                    ]),
                ]),
                h('div', {
                    className: 'vjs-playlist-list' + (sortSwitching ? ' is-sort-switching' : ''),
                    ref: listRef,
                    key: 'list',
                }, sortedItems.map((item) => {
                    const isCurrent = item.name === currentName;
                    return h('div', {
                        key: item.url,
                        ref: isCurrent ? currentItemRef : null,
                        className: 'vjs-playlist-item' + (isCurrent ? ' is-current' : ''),
                        onClick: () => { handleSelect(item); },
                        onDblClick: (e) => onItemDoubleClick(item, e),
                        title: item.name,

                        onMouseDown: (e) => onItemPointerDown(item, e),
                        onMouseMove: (e) => onItemPointerMove(e),
                        onMouseUp: () => onItemPointerUp(),
                        onMouseLeave: () => clearGestureTimer(),

                        onTouchStart: (e) => onItemPointerDown(item, e),
                        onTouchMove: (e) => onItemPointerMove(e),
                        onTouchEnd: () => onItemPointerUp(),
                        onTouchCancel: () => clearGestureTimer(),
                    }, [
                        h('span', {
                            className: 'vjs-playlist-item-icon' + (isCurrent && loopCurrent ? ' is-loop' : ''),
                            title: isCurrent
                                ? (loopCurrent ? 'Loop current video (click to disable)' : 'Loop current video (click to enable)')
                                : '▶\uFE0E',
                            onClick: (e) => {
                                if (isCurrent) toggleLoopCurrent(e);
                            },
                        }, isCurrent && loopCurrent ? '₪\uFE0E' : '▶\uFE0E'),
                        h('span', { className: 'vjs-playlist-item-name' }, [
                            h('span', { className: 'vjs-playlist-item-name-text', key: 'name' }, item.name),
                            (item.episode || item.comment) && h('span', { className: 'vjs-playlist-item-meta', key: 'meta' }, [
                                item.episode && h('span', { className: 'vjs-playlist-item-episode', key: 'ep' }, item.episode),
                                item.episode && item.comment && h('span', { className: 'vjs-playlist-item-meta-space', key: 'sp' }, ' '),
                                item.comment && h('span', { className: 'vjs-playlist-item-comment', key: 'cm' }, item.comment),
                            ]),
                        ]),
                    ]);
                })),
            ]);
        };

        const setupMobileGestures = (player, notify, videoElementRef) => {
            const { enableDoubleTap, doubleTapSeekSeconds } = C;
            if (!player || !enableDoubleTap) return;

            let lastTouchTime = 0;
            let singleTapTimer = null;
            let touchStartX = 0;
            let touchStartY = 0;
            let touchMoved = false;

            const handleTouchStart = (e) => {
                if (e.touches.length !== 1) return;
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                touchMoved = false;
            };

            const handleTouchMove = (e) => {
                if (e.touches.length !== 1) return;
                const dx = Math.abs(e.touches[0].clientX - touchStartX);
                const dy = Math.abs(e.touches[0].clientY - touchStartY);
                if (dx > 10 || dy > 10) touchMoved = true;
            };

            const handleTouch = (e) => {
                const now = Date.now();

                if (touchMoved) {
                    lastTouchTime = now;
                    return;
                }

                const target = e.target;
                if (target.closest && (
                    target.closest('.vjs-control-bar') ||
                    target.closest('.vjs-progress-control') ||
                    target.closest('.vjs-progress-holder') ||
                    target.closest('.vjs-seek-bar') ||
                    target.closest('.vjs-menu') ||
                    target.closest('.vjs-playlist')
                )) {
                    lastTouchTime = now;
                    return;
                }

                const touch = e.changedTouches[0];
                let rect = e.currentTarget.getBoundingClientRect();
                if (rect.width === 0 && videoElementRef.current) {
                    rect = videoElementRef.current.getBoundingClientRect();
                }

                const x = touch.clientX - rect.left;
                const y = touch.clientY - rect.top;
                const width = rect.width;
                const height = rect.height;
                const pctX = x / width;
                const pctY = y / height;

                if (width === 0 || height === 0) return;

                if (pctY > 0.8) {
                    lastTouchTime = now;
                    return;
                }

                const isDoubleTap = (now - lastTouchTime < 300);

                if (isDoubleTap) {
                    e.preventDefault();
                    if (singleTapTimer) {
                        clearTimeout(singleTapTimer);
                        singleTapTimer = null;
                    }

                    const seekSeconds = doubleTapSeekSeconds;

                    if (pctX < 0.3) {
                        if (!brakeFastForward(player) && takeSeekRewindSlot()) {
                            seekDirect(player, Math.max(0, player.currentTime() - seekSeconds));
                            if (!showSeekHint(player, -seekSeconds)) {
                                notify(player, `Rewind ${seekSeconds}s`, "info", 1000);
                            }
                        }
                    } else if (pctX > 0.7) {
                        const target = seekForwardBase(player) + seekSeconds;
                        const res = seekFastForwardTo(player, target);
                        if (res === false) seekDirect(player, target);
                        if (res !== 'capped' && !showSeekHint(player, seekSeconds, res === true)) {
                            notify(player, `Forward ${seekSeconds}s`, "info", 1000);
                        }
                    } else {
                        if (isWrapperFullscreen()) {
                            exitWrapperFullscreen();
                        } else {
                            requestWrapperFullscreen(player);
                        }
                    }
                } else {
                    if (pctX >= 0.3 && pctX <= 0.7) {
                        singleTapTimer = setTimeout(() => {
                            singleTapTimer = null;
                            if (player.paused()) {
                                player.play();
                                notify(player, "Play", "info", 500);
                            } else {
                                player.pause();
                                notify(player, "Pause", "info", 500);
                            }
                        }, 300);
                    }
                }

                lastTouchTime = now;
            };

            const el = player.el();
            if (el) {
                el.style.touchAction = 'manipulation';
                const textTracks = el.querySelectorAll('.vjs-text-track-display');
                if (textTracks) textTracks.forEach(t => t.style.touchAction = 'manipulation');
                const opts = { capture: true, passive: false };
                el.addEventListener('touchstart', handleTouchStart, opts);
                el.addEventListener('touchmove', handleTouchMove, opts);
                el.addEventListener('touchend', handleTouch, opts);
                player.on('dispose', () => {
                    el.removeEventListener('touchstart', handleTouchStart, opts);
                    el.removeEventListener('touchmove', handleTouchMove, opts);
                    el.removeEventListener('touchend', handleTouch, opts);
                    if (singleTapTimer) clearTimeout(singleTapTimer);
                });
            }
        };

        // ============================================================
        // === Touch seek accuracy (Tree-nav / fixed overlay offset) ===
        // ============================================================
        // Video.js 8.10 maps a pointer onto a slider with findPosition(), which only
        // sums offsetLeft/offsetTop along the offsetParent chain. That chain stops at
        // a position:fixed ancestor, so the left offset of HFS's
        // .dialog-backdrop.file-show (equal to the Tree-nav width while it is open)
        // is not included. Touching the progress bar then seeks to a wrong time even
        // though the bar is drawn correctly; closing Tree-nav hides that offset and
        // the seek looks "correct" again. Mouse input was unaffected because it uses
        // event.offsetX relative to the target.
        // Map the pointer with the element's live getBoundingClientRect() instead, so
        // the time axis always follows the bar that is actually displayed and stays
        // correct after the player is compressed, resized, zoomed or scrolled.
        const patchSliderPointerMapping = () => {
            const vjs = window.videojs;
            if (!vjs || typeof vjs.getComponent !== 'function') return;
            const Slider = vjs.getComponent('Slider');
            if (!Slider || !Slider.prototype || Slider.prototype.__hfsRectPointer) return;

            const original = Slider.prototype.calculateDistance;
            if (typeof original !== 'function') return;

            Slider.prototype.calculateDistance = function (event) {
                const el = this.el_;
                if (!el || typeof el.getBoundingClientRect !== 'function') {
                    return original.call(this, event);
                }

                const touch = event && event.changedTouches && event.changedTouches[0];
                const point = touch || event;
                const clientX = point && point.clientX;
                const clientY = point && point.clientY;
                if (typeof clientX !== 'number' || typeof clientY !== 'number') {
                    return original.call(this, event);
                }

                const rect = el.getBoundingClientRect();
                if (!rect || !rect.width || !rect.height) {
                    return original.call(this, event);
                }

                if (typeof this.vertical === 'function' && this.vertical()) {
                    return 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
                }
                return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            };
            Slider.prototype.__hfsRectPointer = true;
        };

        // The progress bar is handled by video.js' own SeekBar: it pauses on
        // mousedown/touchstart and moves the playhead with currentTime(), which
        // makes the picture jump. Keep playback running while scrubbing a
        // playing video and route its seeks through seekFastForwardTo(), so a
        // short forward jump fast-forwards to the target instead. Paused
        // scrubbing keeps video.js' stock still-frame preview.
        const patchSeekBarFastForward = () => {
            const vjs = window.videojs;
            if (!vjs || typeof vjs.getComponent !== 'function') return;
            const SeekBar = vjs.getComponent('SeekBar');
            const Slider = vjs.getComponent('Slider');
            if (!SeekBar || !SeekBar.prototype || SeekBar.prototype.__hfsFastForward) return;
            const baseMouseDown = Slider && Slider.prototype && Slider.prototype.handleMouseDown;
            const originalMouseDown = SeekBar.prototype.handleMouseDown;
            const originalUserSeek = SeekBar.prototype.userSeek_;
            if (typeof baseMouseDown !== 'function' || typeof originalUserSeek !== 'function') return;

            const isPrimaryPointer = (event) => {
                if (!event) return false;
                if (event.button === undefined && event.buttons === undefined) return true;
                if (event.button === 0 && event.buttons === undefined) return true;
                if (event.type === 'mouseup' && event.button === 0 && event.buttons === 0) return true;
                if (event.button === 0 && event.buttons === 1) return true;
                return false;
            };

            SeekBar.prototype.handleMouseDown = function (event) {
                const player = this.player_;
                if (!player || player.isDisposed() || player.paused() || player.ended() ||
                    !isPrimaryPointer(event)) {
                    return originalMouseDown.call(this, event);
                }
                // video.js would pause here; keep playing so a short forward
                // jump can fast-forward (with sound) instead of jumping.
                event.stopPropagation();
                if (event.type === 'mousedown') event.preventDefault();
                this.videoWasPlaying = true;
                baseMouseDown.call(this, event);
            };

            SeekBar.prototype.userSeek_ = function (time) {
                const player = this.player_;
                if (!player || player.isDisposed()) return originalUserSeek.call(this, time);
                const delta = time - player.currentTime();
                const res = seekFastForwardTo(player, time, false);
                if (res === 'capped') return;
                if (res) {
                    if (delta) showSeekHint(player, delta, true);
                    return;
                }
                if (delta) showSeekHint(player, delta);
                return originalUserSeek.call(this, time);
            };

            SeekBar.prototype.__hfsFastForward = true;
        };

        const setupHotkeys = (player, notify, playlistNavRef) => {
            const { enableHotkeys, hotkeySeekStep } = C;
            if (!player || !enableHotkeys) return;

            const handleKey = (e) => {
                if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable) return;
                if (!player || player.isDisposed()) return;

                switch (e.key) {
                    case ' ':
                    case 'k':
                    case 'K':
                        e.preventDefault();
                        player.paused() ? player.play() : player.pause();
                        notify(player, player.paused() ? "Pause" : "Play", "info", 500);
                        break;
                    case 'f':
                    case 'F':
                        e.preventDefault();
                        if (isWrapperFullscreen()) {
                            exitWrapperFullscreen();
                        } else {
                            requestWrapperFullscreen(player);
                        }
                        break;
                    case 'ArrowLeft':
                        e.preventDefault(); e.stopPropagation();
                        if (!brakeFastForward(player) && takeSeekRewindSlot()) {
                            seekDirect(player, player.currentTime() - hotkeySeekStep);
                            if (!showSeekHint(player, -hotkeySeekStep)) {
                                notify(player, `Rewind ${hotkeySeekStep}s`, "info", 500);
                            }
                        }
                        break;
                    case 'ArrowRight':
                        e.preventDefault(); e.stopPropagation();
                        {
                            const target = seekForwardBase(player) + hotkeySeekStep;
                            const res = seekFastForwardTo(player, target);
                            if (res === false) seekDirect(player, target);
                            if (res !== 'capped' && !showSeekHint(player, hotkeySeekStep, res === true)) {
                                notify(player, `Forward ${hotkeySeekStep}s`, "info", 500);
                            }
                        }
                        break;
                    case 'ArrowUp':
                        e.preventDefault(); e.stopPropagation();
                        if (playlistNavRef && playlistNavRef.current) {
                            const nav = playlistNavRef.current;
                            if (nav.canNavigate && nav.canNavigate()) {
                                const moved = nav.goPrev();
                                if (moved) notify(player, "Previous Video", "info", 500);
                            }
                        }
                        break;
                    case 'ArrowDown':
                        e.preventDefault(); e.stopPropagation();
                        if (playlistNavRef && playlistNavRef.current) {
                            const nav = playlistNavRef.current;
                            if (nav.canNavigate && nav.canNavigate()) {
                                const moved = nav.goNext();
                                if (moved) notify(player, "Next Video", "info", 500);
                            }
                        }
                        break;
                }
            };

            document.addEventListener('keydown', handleKey, { capture: true });
            player.on('dispose', () => document.removeEventListener('keydown', handleKey, { capture: true }));
        };

        const VideoJsPlayer = React.forwardRef((props, ref) => {
            const containerRef = React.useRef(null);
            const playerRef = React.useRef(null);
            const videoElementRef = React.useRef(null);
            const dummyVideoRef = React.useRef(null);
            const errorShownRef = React.useRef(false);
            const hevcTimeoutRef = React.useRef(null);
            const toggleBtnRef = React.useRef(null);
            const playlistNavRef = React.useRef(null);
            const hlsRef = React.useRef(null);
            const hlsModeRef = React.useRef(null);

            const [conversionMode, setConversionMode] = React.useState(false);
            const isConvertingRef = React.useRef(false);
            const [seekOffset, setSeekOffset] = React.useState(0);
            const [overlayState, setOverlayState] = React.useState(null);
            const [dynamicPoster, setDynamicPoster] = React.useState(props.poster);
            const [playlistOpen, setPlaylistOpen] = React.useState(() => readPlaylistOpenState(false));
            const [controlsLocked, setControlsLocked] = React.useState(() => {
                try {
                    return localStorage.getItem('vjs-controls-locked') === '1';
                } catch {
                    return false;
                }
            });

            const [isMobilePortrait, setIsMobilePortrait] = React.useState(() => {
                try {
                    return window.matchMedia('(max-width: 640px) and (orientation: portrait)').matches;
                } catch {
                    return false;
                }
            });

            React.useEffect(() => {
                let mq = null;
                try {
                    mq = window.matchMedia('(max-width: 640px) and (orientation: portrait)');
                } catch (e) {
                    return;
                }
                const onChange = () => setIsMobilePortrait(!!mq.matches);
                if (mq.addEventListener) mq.addEventListener('change', onChange);
                else if (mq.addListener) mq.addListener(onChange);
                onChange();
                return () => {
                    if (mq.removeEventListener) mq.removeEventListener('change', onChange);
                    else if (mq.removeListener) mq.removeListener(onChange);
                };
            }, []);

            const toggleControlsLocked = React.useCallback(() => {
                setControlsLocked(prev => {
                    const next = !prev;
                    try {
                        localStorage.setItem('vjs-controls-locked', next ? '1' : '0');
                    } catch {}
                    return next;
                });
            }, []);

            const cssClasses = 'video-js vjs-big-play-centered';

            const containerStyle = {
                position: 'relative',
                flex: '1 1 auto',
                minWidth: 0,
                minHeight: 0,
                width: '100%',
                height: '100%',
            };

            const notify = (player, message, type = 'info', duration = 2000) => {
                if (C.errorStyle === 'toast') {
                    if (HFS && HFS.toast) {
                        HFS.toast(message, type);
                    }
                } else {
                    setOverlayState({ message, type, show: true, persistent: duration === 0 });
                    if (duration > 0) {
                        setTimeout(() => {
                            setOverlayState(prev => prev && prev.message === message ? { ...prev, show: false } : prev);
                        }, duration);
                    }
                }
            };

            const reportBlockedMkv = (player, verdict) => {
                if (!player || player.isDisposed()) return;
                if (errorShownRef.current) return;
                errorShownRef.current = true;
                const codec = verdict && verdict.codec ? ` (${verdict.codec})` : '';
                notify(
                    player,
                    `This MKV cannot be played natively${codec}. Enable "FFmpeg Server Transcoding" to play it.`,
                    'error',
                    0
                );
            };

            const destroyHls = () => {
                if (hlsRef.current) {
                    try { hlsRef.current.destroy(); } catch (e) {}
                    hlsRef.current = null;
                }
                hlsModeRef.current = null;
            };

            // Fallback: play via ?ffmpeg=hls + hls.js (mirrors unsupported-videos main.js).
            const playViaHls = async (player, originalSrc) => {
                if (!player || player.isDisposed() || !originalSrc) return;
                destroyHls();

                const url = new URL(originalSrc, location.href);
                url.searchParams.set('ffmpeg', 'hls');

                const videoEl = player.el()
                    ? player.el().querySelector('video.video-js, video.vjs-tech, .video-js video')
                    : null;
                if (!videoEl) {
                    notify(player, 'Cannot find video element', 'error', 0);
                    return;
                }

                const nativeHls = !!(videoEl.canPlayType && videoEl.canPlayType('application/vnd.apple.mpegurl'));

                const start = async () => {
                    try {
                        if (nativeHls && navigator.vendor === 'Apple Computer, Inc.') {
                            hlsModeRef.current = 'native';
                            player.src({ src: url.href, type: 'application/x-mpegURL' });
                            const p = player.play();
                            if (p && p.catch) p.catch(() => {});
                            return;
                        }
                        await loadHlsLib();
                        if (!player || player.isDisposed()) return;
                        if (!window.Hls.isSupported()) {
                            if (!nativeHls) throw new Error('HLS is not supported by this browser');
                            hlsModeRef.current = 'native';
                            player.src({ src: url.href, type: 'application/x-mpegURL' });
                            const p = player.play();
                            if (p && p.catch) p.catch(() => {});
                            return;
                        }
                        hlsModeRef.current = 'hls.js';
                        const hls = new window.Hls({ maxBufferLength: 12, maxMaxBufferLength: 24 });
                        hls.on(window.Hls.Events.ERROR, (_, data) => {
                            if (data.fatal) {
                                try { hls.destroy(); } catch (e) {}
                                hlsRef.current = null;
                                if (!errorShownRef.current) {
                                    notify(player, 'Video conversion failed', 'error', 0);
                                    errorShownRef.current = true;
                                }
                            }
                        });
                        hls.loadSource(url.href);
                        hls.attachMedia(videoEl);
                        hlsRef.current = hls;
                        const p = player.play();
                        if (p && p.catch) p.catch(() => {});
                    } catch (err) {
                        console.warn('[VideoJS] HLS setup failed:', err);
                        if (!errorShownRef.current) {
                            notify(player, 'Video conversion failed', 'error', 0);
                            errorShownRef.current = true;
                        }
                    }
                };
                start();
            };

            const handlePlaybackError = (player, message = "Video format not supported.") => {
                // Try fMP4 transcoding first (existing behaviour).
                if (C.enable_ffmpeg_transcoding && !isConvertingRef.current) {
                    console.log("[VideoJS] Unsupported video detected. Switching to streaming conversion...");
                    notify(player, "Unsupported format. Attempting conversion...", "info", 3000);
                    const d = player.duration();
                    if (d && d > 0 && d !== Infinity) window._vjs_saved_duration = d;
                    isConvertingRef.current = true;
                    transferRef.transcoding = true;
                    transferRef.player = player;
                    transferRef.videoEl = player.el()
                        ? player.el().querySelector('video.video-js, video.vjs-tech, .video-js video')
                        : null;
                    setConversionMode(true);
                    return;
                }

                // If fMP4 already failed, try HLS fallback.
                if (C.enable_ffmpeg_transcoding && isConvertingRef.current && props.src && hlsModeRef.current === null) {
                    console.log("[VideoJS] fMP4 failed. Falling back to HLS...");
                    notify(player, "Conversion failed. Trying HLS...", "info", 3000);
                    playViaHls(player, props.src);
                    return;
                }

                let displayMessage = message;
                if (message && message.includes("The media could not be loaded")) {
                    displayMessage = "Playback Error: Format not supported or Network issue.";
                }
                if (isConvertingRef.current) {
                    displayMessage = "Transcoding Failed: Server could not process video.";
                    fetch(player.currentSrc(), { method: 'HEAD' }).then(res => {
                        if (res.status === 503 && res.headers.get('X-Transcode-Reason') === 'global_limit') {
                            notify(player, "Server Busy: Too many people watching. Try again later.", "error", 0);
                        }
                    }).catch(e => console.warn("[VideoJS] Error check failed:", e));
                }

                if (!errorShownRef.current) {
                    notify(player, displayMessage, "error", 0);
                    errorShownRef.current = true;
                }
            };

            const hasResumedRef = React.useRef(false);
            const attemptResume = (src) => {
                if (!C.resumePlayback || !src || hasResumedRef.current) return;
                const resumeKey = `vjs-resume-${src.split('/').pop().split('?')[0]}`;
                const savedTime = localStorage.getItem(resumeKey);

                if (savedTime) {
                    const t = parseFloat(savedTime);
                    if (!isNaN(t) && t > 1) {
                        const applyResume = () => {
                            const p = playerRef.current;
                            if (!p) return;
                            if (!p.duration() || (p.duration() - t > 5)) {
                                p.currentTime(t);
                                notify(p, `Resumed at ${Math.round(t)}s`, "info", 2000);
                                hasResumedRef.current = true;
                            }
                        };
                        const p = playerRef.current;
                        if (p) {
                            p.readyState() > 0 ? applyResume() : p.one('loadedmetadata', applyResume);
                        }
                    } else hasResumedRef.current = true;
                } else hasResumedRef.current = true;
            };

            const togglePlaylist = React.useCallback((forceState) => {
                setPlaylistOpen(prev => {
                    const next = (typeof forceState === 'boolean') ? forceState : !prev;
                    writePlaylistOpenState(next);
                    return next;
                });
            }, []);

            React.useEffect(() => {
                const p = playerRef.current;
                if (!p) return;
                const handleLoad = () => { if (props.onLoad) props.onLoad(); };
                p.ready(handleLoad);
                const handlePlay = () => { if (props.onPlay) props.onPlay(); };
                p.on('play', handlePlay);
                return () => { p.off('play', handlePlay); };
            }, [props.src, props.onLoad, props.onPlay]);

            React.useEffect(() => {
                if (!window._videoConfigLogged) {
                    console.log("VideoJS Plugin: Mounted with config:", C);
                    window._videoConfigLogged = true;
                }

                if (!videoElementRef.current && containerRef.current) {
                    const vid = document.createElement('video');
                    vid.className = cssClasses;
                    vid.tabIndex = 0;
                    containerRef.current.appendChild(vid);
                    videoElementRef.current = vid;
                    if (ref) {
                        if (typeof ref === 'function') ref(vid);
                        else if (ref.hasOwnProperty('current')) ref.current = vid;
                    }
                }

                const videoElement = videoElementRef.current;
                const dummyVideo = dummyVideoRef.current;
                if (!videoElement || !dummyVideo) return;

                dummyVideo.play = () => Promise.resolve();

                patchSliderPointerMapping();
                patchSeekBarFastForward();

                const player = videojs(videoElement, {
                    controls: C.controls,
                    autoplay: C.autoplay,
                    muted: false,
                    preload: C.preload,
                    fluid: false,
                    fill: true,
                    inactivityTimeout: C.inactivityTimeout,
                    experimentalSvgIcons: true,
                    controlBar: {
                        muteToggle: false,
                        volumePanel: false,
                        pictureInPictureToggle: false,
                        fullscreenToggle: false,
                        playbackRateMenuButton: false,
                        skipButtons: false
                    },
                    userActions: {
                        hotkeys: false,
                        doubleClick: () => {
                            const p = playerRef.current;
                            if (!p || p.isDisposed()) return;
                            if (isWrapperFullscreen()) {
                                exitWrapperFullscreen();
                            } else {
                                requestWrapperFullscreen(p);
                            }
                        }
                    },
                    sources: [],
                    poster: dynamicPoster
                });
                playerRef.current = player;

                transferRef.player = player;
                transferRef.videoEl = videoElement;

                setupMobileGestures(player, notify, videoElementRef);
                setupHotkeys(player, notify, playlistNavRef);

                const playerEl = player.el();
                if (playerEl) playerEl.tabIndex = 0;

                const enforceVolumeState = () => {
                    if (!player || player.isDisposed()) return;
                    if (player.volume() !== 1.0) player.volume(1.0);
                    if (player.muted()) player.muted(false);
                };

                player.ready(() => {
                    enforceVolumeState();
                    // === 修正 PlayToggle 圖標語義：顯示當前狀態而非下一步動作 ===
                    try {
                        const controlBar = player.getChild('controlBar');
                        const playToggle = controlBar && controlBar.getChild('playToggle');
                        if (playToggle && !playToggle.__iconPatched) {
                            playToggle.__iconPatched = true;

                            playToggle.handlePlay = function (e) {
                                this.removeClass('vjs-ended', 'vjs-paused');
                                this.addClass('vjs-playing');
                                this.setIcon('play');
                                this.controlText('Pause');
                            };

                            playToggle.handlePause = function (e) {
                                this.removeClass('vjs-playing');
                                this.addClass('vjs-paused');
                                this.setIcon('pause');
                                this.controlText('Play');
                            };

                            playToggle.handleEnded = function (e) {
                                this.removeClass('vjs-playing');
                                this.addClass('vjs-ended');
                                this.setIcon('replay');
                                this.controlText('Replay');
                                this.one(this.player_, 'seeked', (ev) => this.handleSeeked(ev));
                            };

                            if (player.paused()) playToggle.handlePause();
                            else playToggle.handlePlay();
                        }
                    } catch (e) {
                        console.warn('[VideoJS] PlayToggle icon patch failed:', e);
                    }
                    player.on('volumechange', enforceVolumeState);

                    // Changing video while a fast-forward scan is running must
                    // not leave the new video muted / at 8x.
                    player.on('loadstart', () => {
                        if (seekFastForward.player === player) seekFastForwardStop('loadstart');
                    });

                    const insertToggleButton = () => {
                        const controlBar = player.getChild('controlBar');
                        const controlBarEl = controlBar && controlBar.el();
                        if (!controlBarEl) return;
                        if (controlBarEl.querySelector('.vjs-playlist-toggle')) return;

                        const btn = document.createElement('button');
                        btn.className = 'vjs-playlist-toggle';
                        btn.title = 'Playlist';
                        btn.type = 'button';
                        btn.setAttribute('aria-label', 'Toggle playlist');
                        btn.innerHTML = '<span class="vjs-playlist-toggle-icon">☰</span>';

                        const initialOpen = readPlaylistOpenState(false);
                        if (initialOpen) btn.classList.add('is-open');

                        btn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            togglePlaylist();
                        });

                        const remainingTime = controlBar.getChild('remainingTimeDisplay');
                        const remainingEl = remainingTime && remainingTime.el();
                        if (remainingEl && remainingEl.parentNode === controlBarEl) {
                            remainingEl.insertAdjacentElement('afterend', btn);
                        } else {
                            const progressControl = controlBar.getChild('progressControl');
                            const progressEl = progressControl && progressControl.el();
                            if (progressEl && progressEl.parentNode === controlBarEl) {
                                progressEl.insertAdjacentElement('afterend', btn);
                            } else {
                                controlBarEl.appendChild(btn);
                            }
                        }
                        toggleBtnRef.current = btn;
                    };

                    insertToggleButton();
                });

                if (C.enableScrollSeek) {
                    let wheelAccum = 0;
                    const WHEEL_NOTCH = 100;
                    const wheelTarget = (() => {
                        const el = player.el();
                        if (!el) return null;
                        let wrapper = el;
                        let parent = el.parentElement;
                        while (parent && parent !== document.body && parent !== document.documentElement) {
                            if (parent.classList && parent.classList.contains('video-js')) break;
                            wrapper = parent;
                            parent = parent.parentElement;
                        }
                        return wrapper;
                    })();
                    const isInsidePlayer = (e) => {
                        const el = player.el();
                        if (!el) return false;
                        let node = e.target;
                        while (node && node !== document.body && node !== document.documentElement) {
                            if (node === el || (wheelTarget && node === wheelTarget)) return true;
                            node = node.parentElement;
                        }
                        const rect = el.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) return false;
                        return (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom);
                    };
                    const handleWheel = (e) => {
                        if (e.deltaY === 0 || !isInsidePlayer(e)) return;
                        if (e.target.closest && e.target.closest('.vjs-playlist')) return;
                        e.preventDefault();
                        let delta = e.deltaY;
                        if (e.deltaMode === 1) delta *= 16;
                        else if (e.deltaMode === 2) delta *= 100;
                        wheelAccum += delta;
                        while (Math.abs(wheelAccum) >= WHEEL_NOTCH) {
                            const dir = wheelAccum > 0 ? 1 : -1;
                            wheelAccum -= dir * WHEEL_NOTCH;
                            const step = C.scrollSeekStep;
                            const duration = player.duration();
                            const base = dir > 0 ? seekForwardBase(player) : player.currentTime();
                            let newTime = base + dir * step;
                            newTime = Math.max(0, Math.min(duration || newTime, newTime));
                            player.userActive(true);
                            if (dir > 0) {
                                const res = seekFastForwardTo(player, newTime);
                                if (res === false) seekDirect(player, newTime);
                                if (res !== 'capped' && !showSeekHint(player, step, res === true)) {
                                    notify(player, `Seek +${step}s`, "info", 500);
                                }
                            } else if (!brakeFastForward(player) && takeSeekRewindSlot()) {
                                seekDirect(player, newTime);
                                if (!showSeekHint(player, -step)) {
                                    notify(player, `Seek -${step}s`, "info", 500);
                                }
                            }
                        }
                    };
                    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
                    player.on('dispose', () => document.removeEventListener('wheel', handleWheel, { passive: false, capture: true }));
                }

                if (props.className) {
                    const wrapperClasses = props.className.replace(/\bshowing\b/g, '').trim();
                    if (wrapperClasses) player.addClass(wrapperClasses);
                }

                if (ref) {
                    if (typeof ref === 'function') ref(videoElement);
                    else if (ref.hasOwnProperty('current')) ref.current = videoElement;
                }

                const debounce = (HFS && HFS._ && HFS._.debounce) ? HFS._.debounce : (func, wait) => {
                    let timeout;
                    const debounced = (...args) => {
                        clearTimeout(timeout);
                        timeout = setTimeout(() => func.apply(this, args), wait);
                    };
                    debounced.cancel = () => {
                        clearTimeout(timeout);
                    };
                    return debounced;
                };

                player.on('playing', () => {
                    setTimeout(() => { if (player && player.el()) player.el().focus(); }, 50);
                    checkHevc();
                });

                const checkHevc = () => {
                    if (!player || player.isDisposed() || player.ended() || isConvertingRef.current) return;
                    const w = player.videoWidth(); const currentSrc = player.currentSrc();
                    if (currentSrc && w === 0) {
                        if (hevcTimeoutRef.current) clearTimeout(hevcTimeoutRef.current);
                        hevcTimeoutRef.current = setTimeout(() => { if (player.videoWidth() === 0) handlePlaybackError(player, "HEVC/Unsupported format detected. Audio may still play."); }, 250);
                    }
                };
                player.on('loadedmetadata', checkHevc);
                player.on('loadeddata', checkHevc);
                player.on('canplay', checkHevc);
                player.on('playing', () => {
                    setTimeout(() => {
                        if (player && !player.isDisposed() && player.videoWidth() === 0 && !isConvertingRef.current) {
                            handlePlaybackError(player, "No video output detected.");
                        }
                    }, 5000);
                });

                const saveProgress = () => {
                    if (!C.resumePlayback || !player || player.isDisposed()) return;
                    if (isConvertingRef.current && !C.enable_transcoding_seeking) return;
                    let cur;
                    try {
                        cur = player.currentTime();
                    } catch (e) {
                        console.warn('[VideoJS] Failed to get currentTime for saveProgress:', e);
                        return;
                    }
                    if (cur > 0 && (!player.duration() || (player.duration() - cur > 10))) {
                        const src = props.src || player.currentSrc();
                        if (src) localStorage.setItem(`vjs-resume-${src.split('/').pop().split('?')[0]}`, cur.toFixed(1));
                    }
                };

                const debouncedSaveProgress = debounce(saveProgress, 2000);
                player.on('timeupdate', debouncedSaveProgress);
                player.on('pause', saveProgress);

                const onFsChange = () => {
                    const fs = isWrapperFullscreen();
                    if (C.autoRotate && screen.orientation && screen.orientation.lock) {
                        if (fs && player.videoWidth() > player.videoHeight()) {
                            screen.orientation.lock('landscape').catch(() => {});
                        } else {
                            try { screen.orientation.unlock(); } catch (e) {}
                        }
                    }
                };
                document.addEventListener('fullscreenchange', onFsChange);
                document.addEventListener('webkitfullscreenchange', onFsChange);
                document.addEventListener('mozfullscreenchange', onFsChange);
                document.addEventListener('MSFullscreenChange', onFsChange);

                player.on('play', () => {
                    setOverlayState(prev => (prev && (prev.type === 'error' || prev.persistent)) ? { ...prev, show: false } : prev);
                    if (props.onPlay) props.onPlay();
                });

                player.on('waiting', () => { if (isConvertingRef.current) player.addClass('vjs-converting'); });
                const clearConverting = () => player.removeClass('vjs-converting');
                player.on('canplay', clearConverting);
                player.on('playing', clearConverting);
                player.on('pause', clearConverting);
                player.on('error', clearConverting);

                player.on('ended', () => {
                    clearConverting();
                    if (props.onEnded) props.onEnded();
                    if (dummyVideoRef.current) dummyVideoRef.current.dispatchEvent(new Event('ended'));
                });

                player.on('error', () => {
                    const code = player.error() ? player.error().code : 0;
                    if (code === 4 || code === 3) {
                        // With transcoding off there is no recovery path; clearing
                        // the error repeatedly can make an unsupported file retry
                        // forever and freeze the page. Handle it once.
                        if (!C.enable_ffmpeg_transcoding && errorShownRef.current) return;
                        player.error(null);
                        handlePlaybackError(player, code === 3
                            ? "Decode error. Attempting conversion..."
                            : "The media could not be loaded, either because the server or network failed or because the format is not supported.");
                        return;
                    }
                    if (props.onError) props.onError(player.error());
                });

                return () => {
                    // Silence the output synchronously so closing the dialog
                    // feels instant, then let HFS remove the dialog before the
                    // heavier media teardown. Native MKV demuxers can otherwise
                    // stall the close for a moment while unwinding.
                    try {
                        if (player && !player.isDisposed()) {
                            player.pause();
                            player.muted(true);
                        }
                    } catch (e) {}
                    const closingVideoEl = videoElementRef.current;
                    try {
                        if (closingVideoEl) {
                            closingVideoEl.pause();
                            closingVideoEl.muted = true;
                        }
                    } catch (e) {}

                    if (debouncedSaveProgress.cancel) debouncedSaveProgress.cancel();
                    saveProgress();
                    if (hevcTimeoutRef.current) clearTimeout(hevcTimeoutRef.current);
                    if (toggleBtnRef.current && toggleBtnRef.current.parentNode) {
                        toggleBtnRef.current.parentNode.removeChild(toggleBtnRef.current);
                        toggleBtnRef.current = null;
                    }
                    document.removeEventListener('fullscreenchange', onFsChange);
                    document.removeEventListener('webkitfullscreenchange', onFsChange);
                    document.removeEventListener('mozfullscreenchange', onFsChange);
                    document.removeEventListener('MSFullscreenChange', onFsChange);

                    setTimeout(() => {
                        destroyHls();
                        hardBrakeVideo(closingVideoEl);
                        try {
                            if (player && !player.isDisposed()) player.dispose();
                        } catch (e) {}
                        if (closingVideoEl && closingVideoEl.parentNode) closingVideoEl.remove();
                        if (containerRef.current) containerRef.current.innerHTML = '';
                    }, 0);
                };
            }, []);

            const prevSrcRef = React.useRef(props.src);
            React.useEffect(() => {
                if (prevSrcRef.current && prevSrcRef.current !== props.src) {
                    console.log('[VideoJS] Braking old source:', prevSrcRef.current, '->', props.src);
                    transferRef.player = playerRef.current;
                    transferRef.videoEl = videoElementRef.current;
                    transferRef.dialogEl = null;
                    interruptCurrentTransfer('src-change');
                }
                prevSrcRef.current = props.src;
            }, [props.src]);

            React.useEffect(() => {
                let cancelled = false;
                const player = playerRef.current;
                if (props.src && player) {
                    const currentSrc = player.currentSrc();
                    if (currentSrc && !decodeURI(currentSrc).includes(decodeURI(props.src))) {
                        setConversionMode(false);
                        isConvertingRef.current = false;
                        transferRef.transcoding = false;
                        setSeekOffset(0);
                        hasResumedRef.current = false;
                        destroyHls();
                    }
                }

                if (player && props.src) {
                    let suffix = conversionMode ? `${props.src.includes('?') ? '&' : '?'}ffmpeg` : '';
                    if (seekOffset > 0) suffix += `&startTime=${seekOffset}`;
                    const targetSrc = props.src + suffix;

                    const currentSrc = player.currentSrc();
                    const needsUpdate = !currentSrc || !decodeURI(currentSrc).includes(decodeURI(targetSrc));

                    if (needsUpdate) {
                        setOverlayState(null);
                        errorShownRef.current = false;

                        const applySource = () => {
                            if (cancelled || !player || player.isDisposed()) return;
                            player.src({ src: targetSrc, type: conversionMode ? 'video/mp4' : determineMimeType(props.src) });
                            if (!conversionMode || C.enable_transcoding_seeking) attemptResume(props.src);

                            const fu = getFolderUri(props.src);
                            const name = getCurrentFilename(player, props.src);
                            const key = fu && name ? fu + name : '';
                            const loopOn = key ? !!loopStateByUrl.get(key) : false;
                            try { player.loop(loopOn); } catch (e) {}

                            if (C.autoplay || conversionMode) {
                                const p = player.play();
                                if (p && p.catch) p.catch(e => {
                                    if (isConvertingRef.current) return;
                                    if (e && e.name === 'NotSupportedError') return;
                                    console.warn("Auto-play blocked:", e);
                                    if (!player || player.isDisposed() || player.paused()) {
                                        notify(player, "Click to Play (Autoplay Blocked)", "info", 0);
                                    }
                                });
                            }
                            if (conversionMode && window._vjs_saved_duration) {
                                player.one('loadedmetadata', () => player.duration(window._vjs_saved_duration));
                            }
                        };

                        const isMkv = /\.mkv$/i.test(props.src.split('?')[0]);
                        if (isMkv && !conversionMode) {
                            // Refuse HEVC/E-AC3/... MKVs before Chrome's demuxer
                            // can get stuck on them. When transcoding is enabled,
                            // jump straight to the server conversion instead of
                            // trying the native pipeline first.
                            probeMkvSupport(props.src).then(verdict => {
                                if (cancelled) return;
                                if (verdict && verdict.blocked) {
                                    if (C.enable_ffmpeg_transcoding && !isConvertingRef.current) {
                                        handlePlaybackError(player, 'Unsupported MKV codecs. Attempting conversion...');
                                    } else {
                                        reportBlockedMkv(player, verdict);
                                    }
                                    return;
                                }
                                applySource();
                            });
                        } else {
                            applySource();
                        }
                    }
                }

                const enforceDuration = () => {
                    if (conversionMode && window._vjs_saved_duration && player) {
                        const d = player.duration();
                        if (d === Infinity || Math.abs(d - window._vjs_saved_duration) > 5) {
                            player.duration(window._vjs_saved_duration);
                            player.hasClass('vjs-live') && player.removeClass('vjs-live');
                        }
                    }
                };
                player.on('durationchange', enforceDuration);
                player.on('timeupdate', enforceDuration);

                let cleanupSeek = null;
                if (conversionMode && C.enable_transcoding_seeking) {
                    const originalCurrentTime = player.currentTime;
                    let seekDebounce = null;
                    player.currentTime = function (time) {
                        if (time === undefined) {
                            const val = originalCurrentTime.call(player);
                            return (val === undefined || isNaN(val)) ? 0 : val + seekOffset;
                        }
                        const targetTime = parseFloat(time);
                        if (targetTime >= 0) {
                            if (transferRef.transcoding) {
                                transferRef.player = player;
                                transferRef.videoEl = player.el()
                                    ? player.el().querySelector('video.video-js, video.vjs-tech, .video-js video')
                                    : null;
                                interruptCurrentTransfer('transcode-seek-pending');
                            }
                            clearTimeout(seekDebounce);
                            seekDebounce = setTimeout(() => {
                                let newOffset = targetTime;
                                if (window._vjs_saved_duration && newOffset > window._vjs_saved_duration) newOffset = window._vjs_saved_duration - 5;
                                if (newOffset < 0) newOffset = 0;
                                if (Math.abs(newOffset - seekOffset) > 1) {
                                    setSeekOffset(newOffset);
                                    notify(player, `Seeking to ${Math.round(newOffset)}s...`, "info", 2000);
                                }
                            }, 600);
                        }
                        return originalCurrentTime.call(player, 0);
                    };
                    cleanupSeek = () => { player.currentTime = originalCurrentTime; clearTimeout(seekDebounce); };
                }

                return () => {
                    cancelled = true;
                    player.off('durationchange', enforceDuration);
                    player.off('timeupdate', enforceDuration);
                    if (cleanupSeek) cleanupSeek();
                };
            }, [props.src, conversionMode, seekOffset]);

            const prevOffsetRef = React.useRef(0);
            React.useEffect(() => {
                const player = playerRef.current;
                if (!player || player.isDisposed()) return;

                const offsetDiff = Math.abs(seekOffset - prevOffsetRef.current);
                if (offsetDiff > BRAKE_SEEK_THRESHOLD && isConvertingRef.current) {
                    console.log('[VideoJS] Braking far seek (transcode):', prevOffsetRef.current, '->', seekOffset);
                }
                prevOffsetRef.current = seekOffset;
            }, [seekOffset]);

            React.useEffect(() => {
                return () => { if (playerRef.current && playerRef.current._seekTimeout) clearTimeout(playerRef.current._seekTimeout); };
            }, []);

            React.useEffect(() => {
                const player = playerRef.current;
                if (!player) return;
                const playerEl = player.el();
                if (!playerEl) return;

                let overlay = playerEl.querySelector('.vjs-custom-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.className = 'vjs-custom-overlay';
                    playerEl.appendChild(overlay);
                }

                if (overlayState && overlayState.show) {
                    overlay.innerHTML = '';
                    overlay.classList.toggle('is-error', overlayState.type === 'error');
                    if (overlayState.type === 'error') {
                        const title = document.createElement('div');
                        title.className = 'vjs-overlay-title';
                        title.textContent = 'Error';
                        overlay.appendChild(title);
                    }
                    const msg = document.createElement('div');
                    msg.textContent = overlayState.message;
                    overlay.appendChild(msg);

                    requestAnimationFrame(() => {
                        overlay.classList.add('is-visible');
                    });
                } else {
                    overlay.classList.remove('is-visible');
                }
            }, [overlayState]);

            React.useEffect(() => {
                const wrapper = containerRef.current && containerRef.current.parentElement;
                if (!wrapper) return;
                wrapper.classList.toggle('playlist-open', playlistOpen);

                const btn = toggleBtnRef.current;
                if (btn) btn.classList.toggle('is-open', playlistOpen);

                const fileShow = wrapper.closest('.file-show');
                const hiddenNavs = [];
                if (fileShow) {
                    fileShow.querySelectorAll('.nav').forEach(nav => {
                        if (nav.style.display === 'none') return;
                        hiddenNavs.push({ el: nav, display: nav.style.display });
                        nav.style.display = 'none';
                    });
                }

                return () => {
                    hiddenNavs.forEach(({ el, display }) => {
                        if (el && el.parentNode) el.style.display = display || '';
                    });
                };
            }, [playlistOpen, props.src]);

            React.useEffect(() => {
                const player = playerRef.current;
                if (!player || player.isDisposed()) return;
                const playerEl = player.el();
                if (!playerEl) return;

                if (controlsLocked && playlistOpen) {
                    playerEl.classList.add('vjs-controls-locked');
                    player.userActive(true);
                } else {
                    playerEl.classList.remove('vjs-controls-locked');
                }
            }, [controlsLocked, playlistOpen]);

            if (!props.src) {
                return h('div', { style: { width: '100%', height: '100%', minHeight: '150px', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', color: '#666', fontFamily: 'sans-serif' } }, 'No Video Selected');
            }

            const wrapperClass = 'vjs-player-wrapper'
                + ' has-playlist'
                + (playlistOpen ? ' playlist-open' : '')
                + (isMobilePortrait ? ' is-mobile-portrait' : '');

            return h('div', {
                className: wrapperClass,
                style: { position: 'relative', width: '100%', height: '100%' },
            }, [
                h('div', {
                    key: 'player',
                    'data-vjs-player': true,
                    ref: containerRef,
                    className: props.className,
                    style: containerStyle,
                }, [
                    h('video', { ref: dummyVideoRef, className: 'showing', style: { display: 'none' } })
                ]),
                h(PlaylistPanel, {
                    key: 'playlist',
                    src: props.src,
                    playerRef: playerRef,
                    open: playlistOpen,
                    portrait: isMobilePortrait,
                    onClose: () => togglePlaylist(false),
                    controlsLocked: controlsLocked,
                    onToggleControlsLocked: toggleControlsLocked,
                    onRegisterNav: (nav) => { playlistNavRef.current = nav; },
                }),
            ]);
        });

        HFS.onEvent('fileShow', (params) => {
            const { entry } = params;
            const ext = entry.n.substring(entry.n.lastIndexOf('.')).toLowerCase();
            const isVideo = VIDEO_EXTS.includes(ext) || (C.enableHLS && (ext === '.m3u8' || ext === '.mkv'));

            if (!isVideo) return;

            let ComponentToUse = VideoJsPlayer;
            if (C.enableSubtitlePluginIntegration && HFS.markVideoComponent) ComponentToUse = HFS.markVideoComponent(ComponentToUse);

            params.Component = (props) => h(ComponentToUse, { ...props, key: props.src, entry: entry });
        });

        if (typeof window !== 'undefined' && !window.VideoJsPlayer) {
            window.VideoJsPlayer = VideoJsPlayer;
        }

        ensureDialogCloseObserver();
        ensureHfsStateWatch();

    } else {
        console.error("VideoJS Plugin: React/Preact not found on window or HFS. Plugin execution aborted.");
    }
}