'use strict';
{
    let { React, h, HFS } = window;

    // Polyfill/Fallback for React
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
            // Hard-coded / Internal settings
            autoplay: true,
            controls: true,
            sizingMode: 'fluid',
            enableScrollSeek: true,
            enableDoubleTap: true,
            autoRotate: true,
            preload: 'metadata',
            enableHLS: true,

            // Configurable settings from plugin.js
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
        };

        // 遠跳 seek 硬剎車閾值（秒）
        const BRAKE_SEEK_THRESHOLD = 30;

        const VIDEO_EXTS = ['.mp4', '.webm', '.ogv', '.mov'];

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

        // --- Helper: 硬剎車 ---
        // 徹底斷開 <video> 的 pending HTTP Range 請求
        // 只適合「確定不再使用此 <video>」時呼叫
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

        // --- Helper: Mobile Gestures Setup ---
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
                    target.closest('.vjs-menu')
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

                // === 底部 20% 盲區：忽略手勢 ===
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
                        player.isFullscreen() ? player.exitFullscreen() : player.requestFullscreen();
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

        // --- Helper: Hotkeys Setup ---
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
                        player.isFullscreen() ? player.exitFullscreen() : player.requestFullscreen();
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

            const [conversionMode, setConversionMode] = React.useState(false);
            const isConvertingRef = React.useRef(false);
            const [seekOffset, setSeekOffset] = React.useState(0);
            const [overlayState, setOverlayState] = React.useState(null);
            const [dynamicPoster, setDynamicPoster] = React.useState(props.poster);

            const cssClasses = 'video-js vjs-big-play-centered';

            const mode = C.sizingMode;

            let containerStyle = {
                position: 'relative'
            };

            switch (mode) {
                case 'fluid':
                default:
                    containerStyle.display = 'contents';
                    break;
            }

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
                    fluid: mode === 'fluid',
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
                    userActions: { hotkeys: false },
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
                });

                // === Feature: Scroll for Seek ===
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

                player.on('fullscreenchange', () => {
                    if (C.autoRotate && screen.orientation && screen.orientation.lock) {
                        player.isFullscreen() && player.videoWidth() > player.videoHeight() ? screen.orientation.lock("landscape").catch(() => {}) : screen.orientation.unlock();
                    }
                });

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
                    // === 剎車：元件卸載時硬剎車舊的 <video> ===
                    hardBrakeVideo(videoElementRef.current);

                    if (debouncedSaveProgress.cancel) debouncedSaveProgress.cancel();
                    saveProgress();
                    if (hevcTimeoutRef.current) clearTimeout(hevcTimeoutRef.current);
                    if (player) player.dispose();
                    if (videoElementRef.current) videoElementRef.current.remove();
                    if (containerRef.current) containerRef.current.innerHTML = '';
                };
            }, []);

            // === 剎車：切換片源時硬剎車舊的 ===
            const prevSrcRef = React.useRef(props.src);
            React.useEffect(() => {
                if (prevSrcRef.current && prevSrcRef.current !== props.src) {
                    console.log('[VideoJS] Braking old source:', prevSrcRef.current, '->', props.src);
                    const player = playerRef.current;
                    const videoEl = videoElementRef.current;

                    // 1. 硬剎車舊的 <video>
                    hardBrakeVideo(videoEl);

                    // 2. 重置 player（清理 SourceBuffer、tech）
                    if (player && !player.isDisposed()) {
                        player.reset();
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

            // === 剎車：遠跳 seek 時硬剎車 ===
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

            if (!props.src) {
                return h('div', { style: { width: '100%', height: '100%', minHeight: '150px', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', color: '#666', fontFamily: 'sans-serif' } }, "No Video Selected");
            }

            return h('div', {
                'data-vjs-player': true,
                ref: containerRef,
                className: props.className,
                style: containerStyle
            }, [
                h('video', { ref: dummyVideoRef, className: 'showing', style: { display: 'none' } })
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