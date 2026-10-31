exports.description = "A simplified & lightweight Video.js player plugin, modified from VenB304/videojs-player.";
exports.version = 2.2;
exports.apiRequired = 10.0;
exports.repo = "Hug3O/Videos-player+";
exports.frontend_css = [
    'style.css',
];

exports.frontend_js = [
    'video.min.js',
    'player.js'
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
    loop: {
        showIf: x => x.config_tab === 'general',
        type: 'boolean', defaultValue: false,
        label: "Loop Playback",
        helperText: "Automatically replay the video when it ends.",
        frontend: true
    },
    resumePlayback: {
        showIf: x => x.config_tab === 'general',
        type: 'boolean', defaultValue: false,
        label: "Remember Playback Position (Resume)",
        helperText: "Saves your progress and resumes video where you left off. (Disabled for Transcoded streams)",
        frontend: true
    },
    inactivityTimeout: {
        showIf: x => x.config_tab === 'general',
        type: 'number', defaultValue: 2000, min: 0,
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
    playlistPanel: {
        showIf: x => x.config_tab === 'general',
        type: 'boolean', defaultValue: true,
        label: "Show Playlist Panel",
        helperText: "Show a PotPlayer-style playlist on the right (desktop) or bottom (mobile portrait).",
        frontend: true
    },

    // ============================================
    // === 2. Interaction ===
    // ============================================
    enableHotkeys: {
        showIf: x => x.config_tab === 'interaction',
        type: 'boolean', defaultValue: true,
        label: "Enable Keyboard Hotkeys",
        helperText: "Space (Pause), F (Fullscreen), Arrows (Seek).",
        frontend: true
    },
    hotkeySeekStep: {
        showIf: x => x.config_tab === 'interaction',
        type: 'number', defaultValue: 5, min: 1,
        label: "Arrow Key Seek Time",
        helperText: "Seconds to skip when pressing Left/Right arrows.",
        frontend: true
    },
    arrowKeysAction: {
        showIf: x => x.config_tab === 'interaction',
        type: 'select', defaultValue: 'seek',
        options: { 'Seek Video (Default)': 'seek', 'Next/Prev File (HFS Navigation)': 'navigate' },
        label: "Arrow Key Behavior",
        helperText: "Choose between seeking the video or navigating to the next file.",
        frontend: true
    },
    scrollSeekStep: {
        showIf: x => x.config_tab === 'interaction',
        type: 'number', defaultValue: 1, min: 0.1, step: 0.1,
        label: "Scroll Seek Step (Seconds)",
        helperText: "How many seconds to jump per wheel notch. Supports decimals, e.g. 0.2 or 0.5.",
        frontend: true
    },
    doubleTapSeekSeconds: {
        showIf: x => x.config_tab === 'interaction',
        type: 'number', defaultValue: 5, min: 1,
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
};

exports.init = api => {
    const running = new Map() // key=process, value=username
    const { spawn } = api.require('child_process')

    function terminate(proc) {
        proc.kill()
        setTimeout(() => proc.kill('SIGKILL'), 10_000)
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
                terminate(proc)
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
                if (ctx.socket.closed) return;

                const ffmpegPath = api.getConfig('ffmpeg_path') || 'ffmpeg';
                const extraParamsStr = api.getConfig('ffmpeg_parameters') || '';
                const hardware = api.getConfig('ffmpeg_hardware_accel') || 'cpu';

                if (/[;&|]/.test(ffmpegPath)) {
                    console.error(`[VideoJS] Security Error: Invalid characters detected in ffmpeg_path: ${ffmpegPath}`);
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

                const mkArgs = (src, start, extra) => {
                    const args = [];
                    if (start > 0) args.push('-ss', String(start));
                    args.push('-i', src);

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
                                args.push('-c:v', 'libx264', '-preset', p, '-pix_fmt', 'yuv420p');
                                break;
                            }
                        }
                    }
                    args.push('pipe:1');
                    return args;
                }

                let spawnCmd = ffmpegPath;
                let spawnArgs = mkArgs(src, startTime, extraParams);
                let spawnOptions = {};

                if (process.platform !== 'win32') {
                    spawnCmd = 'nice';
                    spawnArgs = ['-n', '10', ffmpegPath, ...spawnArgs];
                }

                const proc = spawn(spawnCmd, spawnArgs, spawnOptions);
                running.set(proc, username);

                proc.on('error', (err) => {
                    console.error("VideoJS FFmpeg Error:", err);
                    if (err.code === 'ENOENT') console.error("VideoJS Critical Error: FFmpeg binary not found. Check 'ffmpeg_path' in plugin settings.");
                    running.delete(proc);
                });
                proc.on('exit', (code) => {
                    if (code !== 0 && code !== null) {
                        console.log("VideoJS FFmpeg Process Exited with Error Code:", code);
                        if (code === 1) console.log("VideoJS Hint: Possible invalid arguments or unsupported codec/preset.");
                    }
                    running.delete(proc);
                });

                proc.stderr.on('data', x => console.log('VideoJS FFmpeg:', String(x)));

                ctx.type = 'video/mp4';
                ctx.body = proc.stdout;
                ctx.req.on('end', () => terminate(proc));
                return ctx.status = 200;
            }
        }
    }
}