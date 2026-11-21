exports.description = "A simplified & lightweight Video.js player plugin, modified from VenB304/videojs-player.";
exports.version = 3.8;
exports.apiRequired = 10.0;
exports.repo = "Hug3O/Videos-player+";
exports.frontend_css = [
    'style.css',
];

exports.frontend_js = [
    'video.min.js',
    'player.js',
    'fileshow-help-video.js'
];

exports.config = {
    // ============================================
    // === Configuration Group Selector ===
    // ============================================
    config_tab: {
        type: 'select',
        defaultValue: 'general',
        options: {
            '1. General': 'general',
            '2. Interaction': 'interaction',
            '3. Advanced': 'advanced'
        },
        label: "Configuration Category",
        helperText: "Select a category to view and edit settings.",
        frontend: true
    },

    // ============================================
    // === 1. General ===
    // ============================================
    resumePlayback: {
        showIf: x => x.config_tab === 'general',
        type: 'boolean', defaultValue: false,
        label: "Remember Playback Position (Resume)",
        helperText: "Saves your progress and resumes video where you left off. (Disabled for Transcoded streams)",
        frontend: true
    },
    inactivityTimeout: {
        showIf: x => x.config_tab === 'general',
        type: 'number', defaultValue: 1000, min: 0,
        label: "Auto-Hide Controls (ms)",
        helperText: "How long controls stay visible after mouse movement. Set 0 to keep always visible.",
        frontend: true
    },
    errorStyle: {
        showIf: x => x.config_tab === 'general',
        type: 'select', options: ['overlay', 'toast'], defaultValue: 'overlay',
        label: "Error Notification Style",
        helperText: "'Overlay' covers the player. 'Toast' shows a popup message.",
        frontend: true
    },

    // ============================================
    // === 2. Interaction ===
    // ============================================
    enableHotkeys: {
        showIf: x => x.config_tab === 'interaction',
        type: 'boolean', defaultValue: true,
        label: "Enable Keyboard Hotkeys",
        helperText: "Space (Play/Pause), F (Fullscreen), ←/→ (Seek), ↑/↓ (Previous/Next Video).",
        frontend: true
    },
    hotkeySeekStep: {
        showIf: x => x.config_tab === 'interaction',
        type: 'number', defaultValue: 3, min: 1,
        label: "Arrow Key Seek Time",
        helperText: "Seconds to skip when pressing Left/Right arrows.",
        frontend: true
    },
    scrollSeekStep: {
        showIf: x => x.config_tab === 'interaction',
        type: 'number', defaultValue: 3, min: 0.1, step: 0.1,
        label: "Scroll Seek Step (Seconds)",
        helperText: "How many seconds to jump per wheel notch. Supports decimals, e.g. 0.2 or 0.5.",
        frontend: true
    },
    doubleTapSeekSeconds: {
        showIf: x => x.config_tab === 'interaction',
        type: 'number', defaultValue: 3, min: 1,
        label: "Double Tap Seconds",
        helperText: "Time skipped per double-tap.",
        frontend: true
    },

    // ============================================
    // === 3. Advanced ===
    // ============================================
    enableSubtitlePluginIntegration: {
        showIf: x => x.config_tab === 'advanced',
        type: 'boolean', defaultValue: false,
        label: "Integrate 'hfs-subtitles' Plugin",
        helperText: "Detects the 'hfs-subtitles' plugin to provide advanced subtitle selection. Requires that plugin to be installed separately.",
        frontend: true
    },
    enable_ffmpeg_transcoding: {
        showIf: x => x.config_tab === 'advanced',
        type: 'boolean',
        defaultValue: false,
        label: "Enable FFmpeg Server Transcoding",
        helperText: "Allows playing unsupported files (HEVC, AVI, etc.) by converting them on the server. Requires FFmpeg installed.",
        frontend: true
    },
    enable_transcoding_seeking: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding,
        type: 'boolean',
        defaultValue: false,
        label: "Allow Seeking in Transcoded Videos (Experimental)",
        helperText: "Enables seeking for converted videos. May be slow or unstable depending on CPU/Server speed.",
        frontend: true
    },
    ffmpeg_hardware_accel: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding,
        type: 'select',
        defaultValue: 'cpu',
        options: {
            'Software (x264)': 'cpu',
            'Intel Quick Sync': 'intel_qsv',
            'NVIDIA NVENC': 'nvidia_nvenc',
            'AMD AMF': 'amd_amf',
            'Apple VideoToolbox': 'apple_vt',
            'VAAPI (Linux)': 'vaapi',
            'Stream Copy (No Transcoding)': 'copy',
            'Custom (Manual Configuration)': 'custom'
        },
        label: "Hardware Acceleration",
        helperText: "Select the encoder backend. Ensure your hardware supports it.",
        frontend: true
    },
    preset_cpu: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding && x.ffmpeg_hardware_accel === 'cpu',
        type: 'select', defaultValue: 'medium',
        options: { 'Ultrafast': 'ultrafast', 'Superfast': 'superfast', 'Veryfast': 'veryfast', 'Faster': 'faster', 'Fast': 'fast', 'Medium (Default)': 'medium', 'Slow': 'slow', 'Slower': 'slower', 'Veryslow': 'veryslow' },
        label: "x264 Preset",
        helperText: "Speed vs Quality tradeoff.",
        frontend: true
    },
    preset_intel_qsv: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding && x.ffmpeg_hardware_accel === 'intel_qsv',
        type: 'select', defaultValue: 'balanced',
        options: { 'Very Fast': 'veryfast', 'Faster': 'faster', 'Balanced (Default)': 'balanced', 'Better': 'better', 'Best': 'best' },
        label: "QSV Preset",
        helperText: "Intel QuickSync Quality Balance.",
        frontend: true
    },
    preset_nvidia_nvenc: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding && x.ffmpeg_hardware_accel === 'nvidia_nvenc',
        type: 'select', defaultValue: 'balanced',
        options: { 'Fastest (p1)': 'fastest', 'Fast (p3)': 'fast', 'Balanced (p5)': 'balanced', 'Quality (p6)': 'quality', 'Best Quality (p7)': 'best_quality' },
        label: "NVENC Preset",
        helperText: "NVIDIA Encoder Quality (P-States).",
        frontend: true
    },
    preset_amd_amf: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding && x.ffmpeg_hardware_accel === 'amd_amf',
        type: 'select', defaultValue: 'balanced',
        options: { 'Speed': 'speed', 'Balanced': 'balanced', 'Quality': 'quality' },
        label: "AMF Preset",
        helperText: "AMD Advanced Media Framework Quality.",
        frontend: true
    },
    preset_apple_vt: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding && x.ffmpeg_hardware_accel === 'apple_vt',
        type: 'select', defaultValue: 'balanced',
        options: { 'Low Latency': 'low-latency', 'Balanced': 'balanced', 'Quality': 'quality' },
        label: "VideoToolbox Preset",
        helperText: "Apple Hardware Encoder Quality.",
        frontend: true
    },
    preset_vaapi: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding && x.ffmpeg_hardware_accel === 'vaapi',
        type: 'select', defaultValue: 'balanced',
        options: { 'Fast': 'fast', 'Balanced': 'balanced', 'Quality': 'quality' },
        label: "VAAPI Preset",
        helperText: "Linux VAAPI Quality Simulation.",
        frontend: true
    },
    ffmpeg_path: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding,
        type: 'real_path',
        fileMask: 'ffmpeg*',
        label: "FFmpeg Executable Path",
        helperText: "Path to the ffmpeg.exe or binary. Leave empty if added to system PATH."
    },
    ffmpeg_parameters: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding && x.ffmpeg_hardware_accel === 'custom',
        defaultValue: '',
        label: "Custom FFmpeg Flags",
        helperText: "Enter custom parameters (e.g. -c:v libx265 -crf 23). These are appended to the command. Only visible in 'Custom' mode."
    },
    transcoding_concurrency: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding,
        type: 'number', defaultValue: 3, min: 1, max: 50,
        label: "Max Global Concurrent Streams",
        helperText: "Prevents server overload. Maximum number of conversions happening at once.",
        frontend: true
    },
    transcoding_allow_anonymous: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding,
        type: 'boolean', defaultValue: true,
        label: "Allow Guest Transcoding",
        helperText: "If unchecked, guests must log in to play unsupported videos that require transcoding.",
        frontend: true
    },
    transcoding_rate_limit_per_user: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding && !x.transcoding_allow_anonymous,
        type: 'number', defaultValue: 1, min: 1, max: 10,
        label: "Max Streams Per User",
        helperText: "Limit how many videos a single user can convert at once.",
        frontend: true
    },
    transcoding_allowed_users: {
        showIf: x => x.config_tab === 'advanced' && x.enable_ffmpeg_transcoding && !x.transcoding_allow_anonymous,
        type: 'username', multiple: true,
        label: "Whitelisted Users (Access List)",
        helperText: "Only these users can trigger transcoding. Leave empty to allow all logged-in users.",
        frontend: true
    },
        debug_mode: {
        showIf: x => x.config_tab === 'advanced',
        type: 'boolean',
        defaultValue: false,
        label: "Debug Mode",
        helperText: "Enable verbose server-side logging for transcoding and HLS. Disable in production.",
        frontend: true
    },
};

exports.init = api => {
    const running = new Map(); // key=process, value=username
    const { spawn } = api.require('child_process');

    // HLS server module (copied from unsupported-videos). Required for ?ffmpeg=hls.
    let serveHls = null;
    try {
        serveHls = require('./hls');
    } catch (e) {
        serveHls = null;
    }

    const isDebug = () => {
        try { return !!api.getConfig('debug_mode'); } catch (e) { return false; }
    };
    const dbg = (...args) => { if (isDebug()) console.log('[VideoJS]', ...args); };
    const dbgErr = (...args) => { if (isDebug()) console.error('[VideoJS]', ...args); };
    const dbgWarn = (...args) => { if (isDebug()) console.warn('[VideoJS]', ...args); };

    function terminate(proc) {
        if (!proc || proc.killed || proc.exitCode !== null) return;
        try { proc.kill(); } catch (e) {}
        const force = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 10_000);
        if (force.unref) force.unref();
        proc.once('exit', () => clearTimeout(force));
    }

    const onExit = () => {
        for (const proc of running.keys()) terminate(proc);
    };

    process.on('exit', onExit);
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);

    return {
        unload() {
            process.off('exit', onExit);
            process.off('SIGINT', onExit);
            process.off('SIGTERM', onExit);
            for (const proc of running.keys())
                terminate(proc);
        },
        middleware: async ctx => {
            return async () => { // wait for fileSource to be available
                const src = ctx.state.fileSource;
                if (!src) return;

                // ONLY INTERCEPT for FFMPEG TRANSCODING
                const transcodingEnabled = api.getConfig('enable_ffmpeg_transcoding');
                if (!transcodingEnabled) return;

                const qsObj = new URLSearchParams(ctx.querystring);
                if (!qsObj.has('ffmpeg')) return;

                const username = api.getCurrentUsername(ctx);

                // --- Access Control ---
                const allowAnonymous = api.getConfig('transcoding_allow_anonymous');
                if (!allowAnonymous) {
                    if (!username) return ctx.status = 401;
                    const allowedUsers = api.getConfig('transcoding_allowed_users');
                    if (allowedUsers && allowedUsers.length > 0 && !api.ctxBelongsTo(ctx, allowedUsers)) {
                        return ctx.status = 403;
                    }
                }

                // --- Concurrency Limits (With Preemption) ---
                const maxGlobal = api.getConfig('transcoding_concurrency');
                const maxPerUser = !allowAnonymous ? api.getConfig('transcoding_rate_limit_per_user') : 0;

                if (running.size >= maxGlobal) {
                    ctx.set('X-Transcode-Reason', 'global_limit');
                    ctx.status = 503;
                    ctx.body = "Service Unavailable: Too many concurrent transcoding requests.";
                    return;
                }

                if (maxPerUser > 0) {
                    const userProcs = [];
                    for (const [p, u] of running.entries()) {
                        if (u === username) userProcs.push(p);
                    }
                    if (userProcs.length >= maxPerUser) {
                        const oldest = userProcs[0];
                        terminate(oldest);
                        running.delete(oldest);
                    }
                }

                // Per-User Debounce for fast seeks
                await new Promise(res => setTimeout(res, 200));
                if (ctx.socket && ctx.socket.closed) return;

                const ffmpegPath = api.getConfig('ffmpeg_path') || 'ffmpeg';
                const extraParamsStr = api.getConfig('ffmpeg_parameters') || '';
                const hardware = api.getConfig('ffmpeg_hardware_accel') || 'cpu';

                if (/[;&|]/.test(ffmpegPath)) {
                    dbgErr('Security Error: Invalid characters detected in ffmpeg_path:', ffmpegPath);
                    return ctx.status = 500;
                }

                const extraParams = [];
                let currentToken = '';
                let inQuote = false;
                let quoteChar = '';
                for (let i = 0; i < extraParamsStr.length; i++) {
                    const char = extraParamsStr[i];
                    if (inQuote) {
                        if (char === quoteChar) inQuote = false;
                        else currentToken += char;
                    } else {
                        if (char === '"' || char === "'") {
                            inQuote = true;
                            quoteChar = char;
                        } else if (char === ' ') {
                            if (currentToken.length > 0) {
                                extraParams.push(currentToken);
                                currentToken = '';
                            }
                        } else {
                            currentToken += char;
                        }
                    }
                }
                if (currentToken.length > 0) extraParams.push(currentToken);

                const startTimeInput = qsObj.get('startTime');
                const startTime = startTimeInput ? parseFloat(startTimeInput) : 0;

                // Shared process starter used by both fMP4 and HLS branches.
                const startProcess = (args, stdio = ['ignore', 'pipe', 'ignore']) => {
                    const proc = spawn(ffmpegPath, args, { stdio });
                    running.set(proc, username);
                    dbg('spawn ffmpeg:', ffmpegPath, args.join(' '));

                    const disconnect = () => terminate(proc);

                    // Guard: ctx.res / ctx.req may be null in some request lifecycles.
                    const attachClose = (obj) => {
                        if (obj && typeof obj.once === 'function') {
                            obj.once('close', disconnect);
                            return obj;
                        }
                        return null;
                    };
                    const closeHost = attachClose(ctx.res) || attachClose(ctx.req);

                    const release = () => {
                        running.delete(proc);
                        if (closeHost && typeof closeHost.removeListener === 'function') {
                            closeHost.removeListener('close', disconnect);
                        }
                        dbg('ffmpeg released, running.size =', running.size);
                    };
                    proc.once('error', (err) => {
                        dbgErr('ffmpeg spawn error:', err && err.message ? err.message : err);
                        release();
                    });
                    proc.once('exit', (code) => {
                        if (code !== 0 && code !== null) {
                            dbgErr('ffmpeg exited with code:', code);
                        } else {
                            dbg('ffmpeg exited normally, code:', code);
                        }
                        release();
                    });

                    if (proc.stderr && typeof proc.stderr.on === 'function') {
                        proc.stderr.on('data', x => dbg('ffmpeg stderr:', String(x)));
                    }

                    return proc;
                };

                // ============================================================
                // === HLS branch (?ffmpeg=hls / ?ffmpeg=segment) ===
                // ============================================================
                if (qsObj.get('ffmpeg')) {
                    if (!serveHls) {
                        ctx.status = 501;
                        ctx.body = "HLS server module ('./hls') not found in plugin directory.";
                        return;
                    }
                    ctx.status = 200;
                    try {
                        await serveHls(ctx, qsObj, startProcess, extraParams);
                    } catch (error) {
                        dbgErr('HLS error:', error && error.message ? error.message : error);
                        if (!ctx.headerSent) {
                            ctx.status = 502;
                            ctx.body = "Video conversion failed";
                        }
                    }
                    return;
                }

                // ============================================================
                // === fMP4 branch (?ffmpeg only) ===
                // ============================================================
                const mkArgs = (source, start, extra) => {
                    const args = [];
                    if (start > 0) args.push('-ss', String(start));
                    args.push('-i', source);

                    // Explicit stream mapping: avoid data/subtitle/cover tracks clogging the muxer.
                    args.push('-map', '0:v:0', '-map', '0:a:0?', '-dn', '-sn');
                    // Raise muxing queue for high-bitrate sources.
                    args.push('-max_muxing_queue_size', '4096');

                    if (hardware === 'custom') {
                        args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+delay_moov', '-strict', '-2');
                        if (extra && extra.length > 0) args.push(...extra);
                    } else {
                        args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+delay_moov', '-strict', '-2', '-c:a', 'aac', '-ac', '2');
                        const getPreset = (name) => api.getConfig(name) || 'balanced';
                        switch (hardware) {
                            case 'intel_qsv': {
                                const p = getPreset('preset_intel_qsv');
                                const pMap = { 'veryfast': '7', 'faster': '6', 'balanced': '4', 'better': '2', 'best': '1' };
                                args.push('-c:v', 'h264_qsv', '-preset', pMap[p] || '4', '-global_quality', '23', '-load_plugin', 'hevc_hw');
                                break;
                            }
                            case 'nvidia_nvenc': {
                                const p = getPreset('preset_nvidia_nvenc');
                                const pMap = { 'fastest': 'p1', 'fast': 'p3', 'balanced': 'p5', 'quality': 'p6', 'best_quality': 'p7' };
                                args.push('-c:v', 'h264_nvenc', '-preset', pMap[p] || 'p5', '-tune', 'll');
                                break;
                            }
                            case 'amd_amf': {
                                const p = getPreset('preset_amd_amf');
                                args.push('-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', p);
                                break;
                            }
                            case 'apple_vt': {
                                args.push('-c:v', 'h264_videotoolbox', '-realtime', 'true');
                                break;
                            }
                            case 'vaapi': {
                                const p = getPreset('preset_vaapi');
                                args.push('-c:v', 'h264_vaapi');
                                if (p === 'fast') args.push('-qp', '28');
                                else if (p === 'quality') args.push('-qp', '20');
                                else args.push('-qp', '24');
                                break;
                            }
                            case 'copy': {
                                args.push('-c', 'copy');
                                break;
                            }
                            case 'cpu':
                            default: {
                                const p = getPreset('preset_cpu');
                                args.push('-c:v', 'libx264', '-preset', p, '-pix_fmt', 'yuv420p', '-crf', '23', '-maxrate', '8M', '-bufsize', '16M');
                                break;
                            }
                        }
                    }
                    args.push('pipe:1');
                    return args;
                };

                const proc = startProcess(mkArgs(src, startTime, extraParams));

                if (!proc.stdout) {
                    dbgErr('FFmpeg stdout is null; cannot stream. Spawn likely failed.');
                    ctx.status = 500;
                    ctx.body = 'FFmpeg failed to start';
                    return;
                }

                ctx.type = 'video/mp4';
                ctx.body = proc.stdout;
                return ctx.status = 200;
            }
        }
    };
};