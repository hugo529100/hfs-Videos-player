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

        const C = {
            autoplay: true,
            controls: true,
            sizingMode: 'fluid',
            enableScrollSeek: true,
            enableDoubleTap: true,
            autoRotate: true,
            preload: 'metadata',
            enableHLS: true,

            loop: rawConfig.loop ?? false,
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
            arrowKeysAction: rawConfig.arrowKeysAction || 'seek',
            playlistPanel: rawConfig.playlistPanel ?? true,
        };

        const BRAKE_SEEK_THRESHOLD = 30;
        const VIDEO_EXTS = ['.mp4', '.webm', '.ogv', '.mov'];

        const folderCache = new Map();
        const listScrollCache = new Map();

        // --- Helper: 中文数字解析 ---
        const parseChineseNum = (str) => {
            if (/^\d+$/.test(str)) return parseInt(str);
            const map = { '零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
            if (map[str] !== undefined) return map[str];
            let m = str.match(/^([二三四五六七八九]?十)?([一二三四五六七八九])?$/);
            if (m) {
                let result = 0;
                if (m[1]) result += map[m[1][0]] * 10;
                else if (m[2] && !m[1]) return map[m[2]];
                if (m[2]) result += map[m[2]];
                return result;
            }
            return null;
        };

        // --- Helper: 从文件名提取 episode 标记（与 Visited-filename 插件一致） ---
        const extractEpisode = (name) => {
            if (!name) return null;
            let m = name.match(/s(\d+)e(\d+)/i);
            if (m) return 'S' + parseInt(m[1]) + '-E' + parseInt(m[2]);

            m = name.match(/(?:第)?\s*(\d+|[一二三四五六七八九十]+)\s*季\s*(?:第)?\s*(\d+|[一二三四五六七八九十]+)\s*集/);
            if (m) {
                const s = parseChineseNum(m[1]);
                const e = parseChineseNum(m[2]);
                if (s !== null && e !== null) return 'S' + s + '-E' + e;
            }

            m = name.match(/(?:第)?\s*(\d+|[一二三四五六七八九十]+)\s*季\s*(\d+)\s*(?:集)?/);
            if (m) {
                const s = parseChineseNum(m[1]);
                const e = parseInt(m[2]);
                if (s !== null) return 'S' + s + '-E' + e;
            }

            m = name.match(/第\s*(.+?)\s*集/);
            if (m) {
                const e = parseChineseNum(m[1]);
                if (e !== null) return 'E' + e;
            }

            m = name.match(/第\s*(.+?)\s*(?:部|章|节|篇|卷)/);
            if (m) {
                const p = parseChineseNum(m[1]);
                if (p !== null) return 'P-' + p;
            }

            m = name.match(/part\s*(\d+)/i);
            if (m) return 'P-' + parseInt(m[1]);
            return null;
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

        const hardBrakeVideo = (videoEl) => {
            if (!videoEl) return;
            try {
                videoEl.pause();
                const sources = videoEl.querySelectorAll('source');
                sources.forEach(s => s.remove());
                videoEl.removeAttribute('src');
                videoEl.load();
                videoEl.src = '';
                videoEl.load();
            } catch (e) {
                console.warn('[VideoJS] hardBrakeVideo failed:', e);
            }
        };

        // --- 統一的釋放函數：停止舊請求 + 清理 player 狀態 ---
        // 用於手動切源、刪除當前播放文件、src 變更等所有場景。
        // 只清 tech 與 src，不動 wrapper / PlaylistPanel 的 DOM，
        // 保持界面殘留銜接，視覺上與手動切換一致。
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

        const formatSize = (bytes) => {
            if (bytes == null || isNaN(bytes)) return '';
            if (bytes < 1024) return bytes + ' B';
            const units = ['KB', 'MB', 'GB', 'TB'];
            let v = bytes / 1024;
            let i = 0;
            while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
            return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
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
                    try {
                        v.muted = true;
                        v.pause();
                    } catch (e) {}
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
                        || dialogEl.querySelector('.bar button.icon-button:last-child');
                    if (closeBtn) closeBtn.click();
                    else if (dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl);
                }, fade);
            }, delay);
        };

        const fetchFolderVideos = async (src, forceRefresh = false) => {
            const clean = src.split('?')[0];
            const lastSlash = clean.lastIndexOf('/');
            const folderUri = lastSlash >= 0 ? clean.substring(0, lastSlash + 1) : '';
            if (!folderUri) return [];

            // 强制刷新时，先删除缓存，确保拿到最新的 comment / episode 等数据
            if (forceRefresh) {
                folderCache.delete(folderUri);
            }

            if (!forceRefresh && folderCache.has(folderUri)) {
                return folderCache.get(folderUri);
            }

            try {
                // 加上时间戳，绕过浏览器缓存，确保 comment 是最新的
                const apiUrl = `/~/api/get_file_list?uri=${encodeURIComponent(folderUri)}&_t=${Date.now()}`;
                const res = await fetch(apiUrl, {
                    credentials: 'same-origin',
                    headers: { 'Accept': 'application/json' },
                    cache: 'no-store'
                });
                if (!res.ok) return folderCache.get(folderUri) || [];
                const data = await res.json();
                const list = data && data.list ? data.list : [];

                const isVideo = (name) => {
                    if (!name) return false;
                    const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
                    return VIDEO_EXTS.includes(ext)
                        || (C.enableHLS && (ext === '.m3u8' || ext === '.mkv'));
                };

                const toTs = v => { if (!v) return null; const t = Date.parse(v); return isNaN(t) ? null : t; };

                const items = list
                    .filter(it => it && it.n && isVideo(it.n))
                    .map(it => {
                        const url = folderUri + it.n;
                        return {
                            name: it.n,
                            url,
                            size: (it.s !== undefined && it.s !== null) ? it.s : null,
                            mtime: toTs(it.m),
                            comment: (it.comment !== undefined && it.comment !== null && String(it.comment).trim() !== '')
                                ? String(it.comment)
                                : null,
                            episode: extractEpisode(it.n),
                        };
                    });

                const hfsList = (window.HFS && window.HFS.state && window.HFS.state.list) || [];
                let ordered = items;
                if (hfsList.length > 0) {
                    const byName = new Map();
                    items.forEach(it => byName.set(it.name, it));
                    ordered = [];
                    hfsList.forEach(e => {
                        const n = e && (e.n || e.name);
                        if (n && byName.has(n)) { ordered.push(byName.get(n)); byName.delete(n); }
                    });
                    byName.forEach(it => ordered.push(it));
                }

                folderCache.set(folderUri, ordered);
                return ordered;
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

        const PlaylistPanel = ({ src, playerRef, open, onClose }) => {
            const [items, setItems] = React.useState(() => {
                const fu = getFolderUri(src);
                return fu && folderCache.has(fu) ? folderCache.get(fu) : [];
            });
            const [currentName, setCurrentName] = React.useState('');
            const [loading, setLoading] = React.useState(false);

            const panelRef = React.useRef(null);
            const listRef = React.useRef(null);
            const currentItemRef = React.useRef(null);
            // 標記：此面板實例是否已執行過「首次自動滾動定位」
            const hasAutoScrolledRef = React.useRef(false);
            // 追蹤上一版列表，用於偵測「當前播放文件被刪除」
            const prevItemsRef = React.useRef([]);
            // 避免自動切換過程中重複觸發
            const autoAdvancingRef = React.useRef(false);

            const folderUri = getFolderUri(src);

            // 列表拉取：
            // - 先立即用缓存数据渲染，避免闪空；
            // - 每次 src 变化（切视频）都强制重拉一次，拿到最新的 comment / episode 等；
            // - 重拉不显示 loading（已有数据时原地替换），避免闪烁；
            // - 150ms 防抖，避免快速连切时打爆请求。
            React.useEffect(() => {
                let cancelled = false;
                if (!folderUri) return;

                if (folderCache.has(folderUri)) {
                    setItems(folderCache.get(folderUri));
                } else {
                    setLoading(true);
                }

                const timer = setTimeout(() => {
                    if (cancelled) return;
                    fetchFolderVideos(folderUri, true).then(list => {
                        if (cancelled) return;
                        setItems(list);
                        setLoading(false);
                    });
                }, 150);

                return () => {
                    cancelled = true;
                    clearTimeout(timer);
                };
            }, [folderUri, src]);

            // 当前播放文件名
            React.useEffect(() => {
                if (!src) return;
                const name = getCurrentFilename(playerRef.current, src);
                if (name) setCurrentName(name);
            }, [src]);

            // 播放器事件同步高亮
            React.useEffect(() => {
                const player = playerRef && playerRef.current;
                if (!player || player.isDisposed()) return;

                const syncCurrent = () => {
                    const name = getCurrentFilename(player, src);
                    if (name) setCurrentName(name);
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

            // 僅在「首次進入 fileShow」時自動滾動定位到當前播放項。
            React.useLayoutEffect(() => {
                if (!open || !folderUri) return;
                if (hasAutoScrolledRef.current) return;
                if (!items.length) return;

                const el = listRef.current;
                if (!el) return;

                const currentFilename = getCurrentFilename(playerRef.current, src);
                if (!currentFilename) return;

                const idx = items.findIndex(it => it.name === currentFilename);
                if (idx < 0) return;

                const target = el.querySelectorAll('.vjs-playlist-item')[idx];
                if (target && target.scrollIntoView) {
                    const prevBehavior = el.style.scrollBehavior;
                    el.style.scrollBehavior = 'auto';
                    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
                    el.style.scrollBehavior = prevBehavior;
                }

                hasAutoScrolledRef.current = true;
            }, [open, folderUri, items, src]);

            // 面板關閉時重置「首次滾動」標記，讓下次開啟 fileShow 能重新定位
            React.useEffect(() => {
                if (!open) {
                    hasAutoScrolledRef.current = false;
                }
            }, [open]);

            // 监听滚动，实时记录位置
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

            // --- 刪除當前播放文件後的自動銜接 ---
            // 機制：把「刪除」視為一次 src 切換。先釋放舊 player 狀態（停止對已刪
            // 除文件的請求），再復用 handleSelect 播放下一個，界面保持殘留銜接。
            React.useEffect(() => {
                const prev = prevItemsRef.current;
                const curr = items;
                if (!prev.length) {
                    prevItemsRef.current = curr;
                    return;
                }

                const currentFilename = getCurrentFilename(playerRef.current, src);
                if (!currentFilename) {
                    prevItemsRef.current = curr;
                    return;
                }

                const existedBefore = prev.some(it => it.name === currentFilename);
                const existsNow = curr.some(it => it.name === currentFilename);

                if (existedBefore && !existsNow && !autoAdvancingRef.current) {
                    const player = playerRef.current;
                    if (!player || player.isDisposed()) {
                        prevItemsRef.current = curr;
                        return;
                    }

                    // 1) 立即釋放舊視頻，停止對已刪除文件的請求（避免 404 重試卡頓）
                    releasePlayer(player);

                    // 2) 決定下一個可播項：原位置優先，否則最後一個
                    const oldIdx = prev.findIndex(it => it.name === currentFilename);
                    const nextItem = curr[oldIdx] || curr[curr.length - 1] || null;

                    // 3) 延遲兩幀再切，等列表 DOM 更新完，避免焦點/動畫衝突
                    if (nextItem) {
                        autoAdvancingRef.current = true;
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                try {
                                    handleSelectRef.current && handleSelectRef.current(nextItem);
                                } finally {
                                    autoAdvancingRef.current = false;
                                }
                            });
                        });
                    } else {
                        // 列表已空 → 保持釋放後的靜止狀態即可
                        setCurrentName('');
                    }
                }

                prevItemsRef.current = curr;
            }, [items, src]);

            // handleSelect 的 ref（避免閉包捕獲舊 playerRef/src）
            const handleSelectRef = React.useRef(null);

            const handleSelect = (item) => {
                const player = playerRef && playerRef.current;
                if (!player || player.isDisposed()) return;

                const playerSrc = (() => {
                    try { return decodeURI(player.currentSrc().split('?')[0]); } catch { return ''; }
                })();
                if (decodeURI(item.url) === playerSrc) return;

                // 记录切换前是否正在播放，用于决定切换后是否继续播放
                const wasPlaying = !player.paused();

                // 無論走哪個分支，切源前先徹底釋放舊狀態。
                // 這樣舊 <video> 已 load() 空白 src，不會再對舊文件（可能已被刪除）
                // 發請求；界面 wrapper / PlaylistPanel DOM 保留，視覺上是殘留銜接。
                releasePlayer(player);

                // 全屏时直接切源，不经过 HFS.fileShow，避免触发 Auto-play 按钮
                if (isWrapperFullscreen()) {
                    player.src({ src: item.url, type: determineMimeType(item.url) });
                    if (wasPlaying) {
                        const p = player.play();
                        if (p && p.catch) p.catch(() => {});
                    }
                    syncHfsFileShowBar(item);
                    setCurrentName(item.name);
                    return;
                }

                const entry = findHfsEntryByName(item.name);
                if (!entry || typeof HFS.fileShow !== 'function') {
                    player.src({ src: item.url, type: determineMimeType(item.url) });
                    if (wasPlaying) {
                        const p = player.play();
                        if (p && p.catch) p.catch(() => {});
                    }
                    syncHfsFileShowBar(item);
                    setCurrentName(item.name);
                    return;
                }

                const oldDialogs = Array.from(document.querySelectorAll('.file-show'));
                oldDialogs.forEach(stopVideosIn);

                try {
                    // 關鍵：不傳 startPlaying: true，避免 HFS 強制把 Auto-play 按鈕切成 true。
                    // 是否播放由我們自己根據 wasPlaying 決定。
                    HFS.fileShow(entry, { startPlaying: false });
                } catch (e) {
                    console.warn('[VideoJS] HFS.fileShow threw:', e);
                    player.src({ src: item.url, type: determineMimeType(item.url) });
                    if (wasPlaying) {
                        const p = player.play();
                        if (p && p.catch) p.catch(() => {});
                    }
                    syncHfsFileShowBar(item);
                    setCurrentName(item.name);
                    return;
                }

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const all = Array.from(document.querySelectorAll('.file-show'));
                        const newest = all[all.length - 1];
                        oldDialogs.forEach(d => {
                            if (d !== newest && d.parentNode) closeWithFade(d, 180, 220);
                        });

                        // 如果切換前正在播放，則讓新播放器繼續播放
                        if (wasPlaying && newest) {
                            const newVideoEl = newest.querySelector('video.video-js, video.vjs-tech, .video-js video');
                            if (newVideoEl) {
                                const newPlayer = videojs.getPlayer(newVideoEl);
                                if (newPlayer && !newPlayer.isDisposed()) {
                                    const playPromise = newPlayer.play();
                                    if (playPromise && playPromise.catch) playPromise.catch(() => {});
                                }
                            }
                        }
                    });
                });
            };

            // 更新 ref，讓自動銜接的 effect 能呼叫最新的 handleSelect
            handleSelectRef.current = handleSelect;

            return h('div', {
                className: 'vjs-playlist' + (open ? ' is-open' : ''),
                ref: panelRef,
            }, [
                h('div', { className: 'vjs-playlist-header', key: 'header' }, [
                    h('span', { className: 'vjs-playlist-title' }, loading ? '※\uFE0E Loading…' : '☰\uFE0E Playlist'),
                    h('span', { className: 'vjs-playlist-count' }, `${items.length}`),
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
                    }, '✖\uFE0E'),
                ]),
                h('div', {
                    className: 'vjs-playlist-list',
                    ref: listRef,
                    key: 'list',
                }, items.map((item) => {
                    const isCurrent = item.name === currentName;
                    return h('div', {
                        key: item.url,
                        ref: isCurrent ? currentItemRef : null,
                        className: 'vjs-playlist-item' + (isCurrent ? ' is-current' : ''),
                        onClick: () => { handleSelect(item); },
                        title: item.name,
                    }, [
                        h('span', { className: 'vjs-playlist-item-icon' }, '▶\uFE0E'),
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
                        player.currentTime(Math.max(0, player.currentTime() - seekSeconds));
                        notify(player, `Rewind ${seekSeconds}s`, "info", 1000);
                    } else if (pctX > 0.7) {
                        player.currentTime(Math.min(player.duration(), player.currentTime() + seekSeconds));
                        notify(player, `Forward ${seekSeconds}s`, "info", 1000);
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

        const setupHotkeys = (player, notify) => {
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
                        if (C.arrowKeysAction === 'navigate') return;
                        e.preventDefault(); e.stopPropagation();
                        player.currentTime(player.currentTime() - hotkeySeekStep);
                        notify(player, `Rewind ${hotkeySeekStep}s`, "info", 500);
                        break;
                    case 'ArrowRight':
                        if (C.arrowKeysAction === 'navigate') return;
                        e.preventDefault(); e.stopPropagation();
                        player.currentTime(player.currentTime() + hotkeySeekStep);
                        notify(player, `Forward ${hotkeySeekStep}s`, "info", 500);
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

            const [conversionMode, setConversionMode] = React.useState(false);
            const isConvertingRef = React.useRef(false);
            const [seekOffset, setSeekOffset] = React.useState(0);
            const [overlayState, setOverlayState] = React.useState(null);
            const [dynamicPoster, setDynamicPoster] = React.useState(props.poster);
            const [playlistOpen, setPlaylistOpen] = React.useState(() => readPlaylistOpenState(false));

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

            const handlePlaybackError = (player, message = "Video format not supported.") => {
                if (C.enable_ffmpeg_transcoding && !isConvertingRef.current) {
                    console.log("[VideoJS] Unsupported video detected. Switching to streaming conversion...");
                    notify(player, "Unsupported format. Attempting conversion...", "info", 3000);
                    const d = player.duration();
                    if (d && d > 0 && d !== Infinity) window._vjs_saved_duration = d;
                    isConvertingRef.current = true;
                    setConversionMode(true);
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

                const player = videojs(videoElement, {
                    controls: C.controls,
                    autoplay: C.autoplay,
                    loop: C.loop,
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

                setupMobileGestures(player, notify, videoElementRef);
                setupHotkeys(player, notify);

                const playerEl = player.el();
                if (playerEl) playerEl.tabIndex = 0;

                const enforceVolumeState = () => {
                    if (!player || player.isDisposed()) return;
                    if (player.volume() !== 1.0) player.volume(1.0);
                    if (player.muted()) player.muted(false);
                };

                player.ready(() => {
                    enforceVolumeState();
                    player.on('volumechange', enforceVolumeState);

                    const insertToggleButton = () => {
                        if (C.playlistPanel === false) return;

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
                            let newTime = player.currentTime() + dir * step;
                            newTime = Math.max(0, Math.min(duration || newTime, newTime));
                            player.currentTime(newTime);
                            player.userActive(true);
                            notify(player, `Seek ${dir > 0 ? '+' : '-'}${step}s`, "info", 500);
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
                    if (code === 4) {
                        player.error(null);
                        handlePlaybackError(player, "The media could not be loaded, either because the server or network failed or because the format is not supported.");
                        return;
                    }
                    if (props.onError) props.onError(player.error());
                });

                return () => {
                    hardBrakeVideo(videoElementRef.current);

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
                    if (player) player.dispose();
                    if (videoElementRef.current) videoElementRef.current.remove();
                    if (containerRef.current) containerRef.current.innerHTML = '';
                };
            }, []);

            // --- src 變更時釋放舊狀態（使用統一的 releasePlayer） ---
            const prevSrcRef = React.useRef(props.src);
            React.useEffect(() => {
                if (prevSrcRef.current && prevSrcRef.current !== props.src) {
                    console.log('[VideoJS] Braking old source:', prevSrcRef.current, '->', props.src);
                    const player = playerRef.current;
                    if (player && !player.isDisposed()) {
                        releasePlayer(player, videoElementRef.current);
                    } else {
                        hardBrakeVideo(videoElementRef.current);
                    }
                }
                prevSrcRef.current = props.src;
            }, [props.src]);

            React.useEffect(() => {
                const player = playerRef.current;
                if (props.src && player) {
                    const currentSrc = player.currentSrc();
                    if (currentSrc && !decodeURI(currentSrc).includes(decodeURI(props.src))) {
                        setConversionMode(false);
                        isConvertingRef.current = false;
                        setSeekOffset(0);
                        hasResumedRef.current = false;
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
                        player.src({ src: targetSrc, type: conversionMode ? 'video/mp4' : determineMimeType(props.src) });
                        if (!conversionMode || C.enable_transcoding_seeking) attemptResume(props.src);

                        if (C.autoplay || conversionMode) {
                            const p = player.play();
                            if (p && p.catch) p.catch(e => {
                                if (isConvertingRef.current) return;
                                console.warn("Auto-play blocked:", e);
                                if (!player || player.isDisposed() || player.paused()) {
                                    notify(player, "Click to Play (Autoplay Blocked)", "info", 0);
                                }
                            });
                        }
                        if (conversionMode && window._vjs_saved_duration) {
                            player.one('loadedmetadata', () => player.duration(window._vjs_saved_duration));
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
                if (fileShow && C.playlistPanel !== false) {
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

            if (!props.src) {
                return h('div', { style: { width: '100%', height: '100%', minHeight: '150px', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', color: '#666', fontFamily: 'sans-serif' } }, 'No Video Selected');
            }

            const showPlaylist = C.playlistPanel !== false;
            const isMobilePortrait = (() => {
                try { return window.matchMedia('(max-width: 640px) and (orientation: portrait)').matches; } catch { return false; }
            })();

            const wrapperClass = 'vjs-player-wrapper'
                + (showPlaylist ? ' has-playlist' : '')
                + (showPlaylist && playlistOpen ? ' playlist-open' : '')
                + (showPlaylist && isMobilePortrait ? ' is-mobile-portrait' : '');

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
                showPlaylist && h(PlaylistPanel, {
                    key: 'playlist',
                    src: props.src,
                    playerRef: playerRef,
                    open: playlistOpen,
                    onClose: () => togglePlaylist(false),
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

    } else {
        console.error("VideoJS Plugin: React/Preact not found on window or HFS. Plugin execution aborted.");
    }
}