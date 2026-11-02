'use strict';
(function () {
    const HELP_TITLE = 'Video Player Help';
    const STYLE_ID = 'ib-help-video-style';
    const HELP_ICON = 'Ⓗ\uFE0E';
    const HELP_TITLE_ATTR = 'Video Player Help';

    let helpSession = null;

    function getPlayerVideoEl() {
        return document.querySelector(
            '.file-show .showing-container video.vjs-tech, ' +
            '.file-show .showing-container video.video-js, ' +
            '.file-show .showing-container video'
        );
    }

    function pausePlayers() {
        document.querySelectorAll('.file-show video').forEach(v => {
            try { v.pause(); } catch (e) {}
        });
    }

    function isInsideHelpDialog(target) {
        if (!target || !target.closest) return false;
        return !!target.closest('.ibhv-backdrop, .ibhv-dialog, .ibhv-help');
    }

    function onHelpWheelCapture(e) {
        if (isInsideHelpDialog(e.target)) {
            e.stopImmediatePropagation();
            e.stopPropagation();
        }
    }

    function onHelpKeyCapture(e) {
        if (!helpSession) return;
        if (isInsideHelpDialog(e.target) || isInsideHelpDialog(document.activeElement)) {
            if (e.key !== 'Escape') {
                e.stopImmediatePropagation();
                e.stopPropagation();
            }
        }
    }

    function onHelpTouchCapture(e) {
        if (isInsideHelpDialog(e.target)) {
            e.stopImmediatePropagation();
            e.stopPropagation();
        }
    }

    function enterHelpSession() {
        if (helpSession) return;
        helpSession = { wasPlaying: false };

        const video = getPlayerVideoEl();
        if (video) {
            try {
                helpSession.wasPlaying = !video.paused && !video.ended;
            } catch (e) {}
        }
        pausePlayers();

        window.addEventListener('wheel', onHelpWheelCapture, { capture: true, passive: false });
        window.addEventListener('keydown', onHelpKeyCapture, true);
        window.addEventListener('touchstart', onHelpTouchCapture, { capture: true, passive: true });
        window.addEventListener('touchmove', onHelpTouchCapture, { capture: true, passive: true });
        window.addEventListener('touchend', onHelpTouchCapture, { capture: true, passive: true });
    }

    function exitHelpSession(resume = true) {
        if (!helpSession) return;
        const wasPlaying = helpSession.wasPlaying;
        helpSession = null;

        window.removeEventListener('wheel', onHelpWheelCapture, { capture: true });
        window.removeEventListener('keydown', onHelpKeyCapture, true);
        window.removeEventListener('touchstart', onHelpTouchCapture, { capture: true });
        window.removeEventListener('touchmove', onHelpTouchCapture, { capture: true });
        window.removeEventListener('touchend', onHelpTouchCapture, { capture: true });

        if (resume && wasPlaying) {
            const video = getPlayerVideoEl();
            if (video) {
                const p = video.play();
                if (p && p.catch) p.catch(() => {});
            }
        }
    }

    function isVideoMode() {
        const viewer = document.querySelector('.file-show');
        if (!viewer) return false;
        const container = viewer.querySelector('.showing-container');
        if (!container) return false;
        return !!container.querySelector('.vjs-player-wrapper, video.vjs-tech, .video-js, video');
    }

    function getHelpButtons() {
        return document.querySelectorAll('.file-show .bar button.icon-button');
    }

    function patchHelpButton(btn) {
        if (!btn) return;
        const txt = (btn.textContent || '').trim();
        const title = btn.getAttribute('title') || '';
        const isHelp = txt === '?' || title === '?';
        if (!isHelp) return;
        if (!isVideoMode()) return;

        if (btn.textContent !== HELP_ICON) {
            btn.textContent = HELP_ICON;
        }
        if (btn.getAttribute('title') !== HELP_TITLE_ATTR) {
            btn.setAttribute('title', HELP_TITLE_ATTR);
        }
        if (btn.dataset.ibHelpVideo === undefined) {
            btn.dataset.ibHelpVideo = '1';
        }
    }

    function patchAllHelpButtons() {
        if (!isVideoMode()) return;
        getHelpButtons().forEach(patchHelpButton);
    }

    function isHelpButton(btn) {
        if (!btn) return false;
        if (btn.dataset && btn.dataset.ibHelpVideo === '1') return true;
        const txt = (btn.textContent || '').trim();
        const title = btn.getAttribute('title') || '';
        return txt === '?' || txt === HELP_ICON ||
               title === '?' || title === HELP_TITLE_ATTR;
    }

    function section(title, rows) {
        return (
            '<div class="ibhv-section">' +
                '<div class="ibhv-section-title">' + title + '</div>' +
                '<div class="ibhv-rows">' + rows.join('') + '</div>' +
            '</div>'
        );
    }

    function row(keys, desc) {
        const k = keys.map(x => '<kbd>' + x + '</kbd>').join(' ');
        return (
            '<div class="ibhv-row">' +
                '<div class="ibhv-keys">' + k + '</div>' +
                '<div class="ibhv-desc">' + desc + '</div>' +
            '</div>'
        );
    }

    function note(text) {
        return '<div class="ibhv-note">' + text + '</div>';
    }

    function divider() {
        return '<div class="ibhv-divider"></div>';
    }

    function buildHelpHtml() {
        return '<div class="ibhv-help">' + [

            section('Quick Start', [
                note('Click the video to play or pause. Use the playlist on the right to switch videos.'),
                note('Space to play/pause, F for fullscreen, \u2190\uFE0E / \u2192\uFE0E to seek, \u2191\uFE0E / \u2193\uFE0E to move in the playlist.'),
            ]),

            divider(),

            section('Keyboard', [
                row(['Space'], 'Play / pause'),
                row(['\u2190\uFE0E', '\u2192\uFE0E'], 'Seek backward / forward (default 5s, configurable)'),
                row(['\u2191\uFE0E', '\u2193\uFE0E'], 'Previous / next video in the playlist'),
                row(['F'], 'Toggle fullscreen'),
            ]),

            section('Mouse', [
                row(['Click video'], 'Play / pause'),
                row(['Double-click video'], 'Toggle fullscreen'),
                row(['Mouse wheel'], 'Seek by the configured step (when enabled)'),
                row(['Progress bar'], 'Click or drag to seek'),
            ]),

            section('Touch', [
                row(['Tap center'], 'Play / pause'),
                row(['Double-tap left'], 'Rewind (default 5s)'),
                row(['Double-tap right'], 'Fast forward (default 5s)'),
                row(['Double-tap center'], 'Toggle fullscreen'),
            ]),

            section('Playlist Panel', [
                row(['\u2630\uFE0E', 'Playlist'], 'Show / hide the playlist'),
                row(['Click title', '\u2630\uFE0E / |||'], 'Toggle sort mode: default order (\u2630\uFE0E) / numeric order (|||)'),
                row(['\u25B2\uFE0E', '\u25B3\uFE0E'], 'Lock / unlock control bar visibility'),
                row(['\u25E2\uFE0E'], 'Hide playlist panel'),
                row(['Item click'], 'Play that video'),
                row(['Long press', 'Double-click'], 'Open the file comment dialog'),
                note('Playlist count shows total / current position. Bitrate is shown when available.'),
            ]),

            section('Player Controls', [
                row(['\u25B6\uFE0E', 'II\uFE0E'], 'Play / pause button'),
                row(['\u26F6\uFE0E'], 'Fullscreen'),
                row(['Progress bar'], 'Buffered and played ranges'),
                row(['Time labels'], 'Current / total, remaining time'),
                note('Volume controls are intentionally hidden; audio starts at full volume.'),
            ]),

            section('Subtitles & Audio', [
                row(['CC'], 'Captions / subtitles (if the file provides them)'),
                row(['Audio'], 'Audio track selection (if available)'),
                note('Advanced subtitle support requires the optional "hfs-subtitles" plugin.'),
            ]),

            section('Large / Unsupported Files', [
                note('If the file cannot be played natively and FFmpeg transcoding is enabled, the player switches to server-side transcoding automatically.'),
                note('During transcoding, seeking may be limited or slower depending on the server and settings.'),
                note('A "Transcoding Media\u2026" overlay is shown while the server prepares the stream.'),
            ]),

            section('Notes', [
                note('Playback progress, volume and playlist state are kept by the player.'),
                note('Fullscreen hides the playlist; press F or Esc to exit.'),
                note('Some shortcuts may be disabled by the plugin configuration.'),
            ]),

        ].join('') + '</div>';
    }

    function isFileShowHelpDialog(dialog) {
        if (!dialog || !dialog.classList || !dialog.classList.contains('dialog')) return false;
        const t = dialog.querySelector('.dialog-title');
        if (!t) return false;
        return /file show help/i.test(t.textContent || '');
    }

    function rewriteHelpDialog(dialog) {
        if (!isVideoMode()) return;
        if (!isFileShowHelpDialog(dialog)) return;
        const title = dialog.querySelector('.dialog-title');
        const content = dialog.querySelector('.dialog-content');
        if (!title || !content) return;
        title.textContent = HELP_TITLE;
        content.innerHTML = buildHelpHtml();
        dialog.dataset.ibHelpVideoRewritten = '1';
    }

    function openHelpDialog() {
        enterHelpSession();

        const backdrop = document.createElement('div');
        backdrop.className = 'dialog-backdrop file-show ibhv-backdrop';
        backdrop.innerHTML =
            '<div role="dialog" aria-modal="true" class="dialog ibhv-dialog">' +
                '<button aria-label="Close" class="dialog-icon dialog-closer">x</button>' +
                '<h1 class="dialog-title">' + HELP_TITLE + '</h1>' +
                '<div class="dialog-content">' + buildHelpHtml() + '</div>' +
            '</div>';

        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            backdrop.remove();
            document.removeEventListener('keydown', onEsc, true);
            exitHelpSession(true);
        };
        const onEsc = (ev) => {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                close();
            }
        };
        backdrop.querySelector('.dialog-closer').addEventListener('click', close);
        backdrop.addEventListener('click', (ev) => {
            if (ev.target === backdrop) close();
        });
        document.addEventListener('keydown', onEsc, true);
        document.body.appendChild(backdrop);
        backdrop.querySelector('.dialog').dataset.ibHelpVideoRewritten = '1';
    }

    function onDocumentClickCapture(e) {
        const btn = e.target && e.target.closest
            ? e.target.closest('.file-show .bar button.icon-button')
            : null;
        if (!btn) return;
        if (!isHelpButton(btn)) return;
        if (!isVideoMode()) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const existing = document.querySelector('.dialog .dialog-title');
        if (existing && /file show help/i.test(existing.textContent || '')) {
            rewriteHelpDialog(existing.closest('.dialog'));
            enterHelpSession();
            return;
        }
        openHelpDialog();
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent = `
.ibhv-dialog { max-width: 720px; }
.ibhv-help {
    display: flex; flex-direction: column; gap: 14px;
    padding: 4px 0; max-height: 72vh; overflow-y: auto;
}
.ibhv-section { display: flex; flex-direction: column; gap: 6px; }
.ibhv-section-title {
    font-size: 12px; font-weight: 700; letter-spacing: .6px;
    text-transform: uppercase; opacity: .65;
    border-bottom: 1px solid currentColor;
    padding-bottom: 3px; margin-bottom: 2px;
}
.ibhv-rows { display: flex; flex-direction: column; gap: 5px; }
.ibhv-row {
    display: grid; grid-template-columns: 170px 1fr;
    gap: 10px; align-items: center;
    font-size: 13px; line-height: 1.45;
}
.ibhv-keys { display: flex; flex-wrap: wrap; gap: 4px; }
.ibhv-keys kbd {
    display: inline-block; min-width: 20px; text-align: center;
    padding: 1px 6px; border-radius: 4px;
    border: 1px solid currentColor; opacity: .85;
    font-family: inherit; font-size: 11px;
    background: color-mix(in srgb, currentColor 8%, transparent);
}
.ibhv-desc { opacity: .92; }
.ibhv-note {
    font-size: 12.5px; line-height: 1.55; opacity: .85;
    padding: 7px 11px; border-radius: 6px;
    background: color-mix(in srgb, currentColor 6%, transparent);
}
.ibhv-divider {
    height: 1px; width: 100%;
    background: color-mix(in srgb, currentColor 15%, transparent);
    margin: 2px 0;
}
@media (max-width: 480px) {
    .ibhv-row { grid-template-columns: 120px 1fr; font-size: 12px; }
    .ibhv-keys kbd { font-size: 10px; padding: 1px 4px; }
    .ibhv-note { font-size: 12px; padding: 6px 9px; }
}

:root .theme-dark .dialog-backdrop.ibhv-backdrop,
:root .theme-dark .dialog-backdrop.ibhi-backdrop,
.dialog-backdrop.ibhv-backdrop,
.dialog-backdrop.ibhi-backdrop {
    background-color: transparent !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}
`;
        document.head.appendChild(st);
    }

    function scanDialogs(root) {
        if (!isVideoMode()) return;
        const scope = root && root.querySelectorAll ? root : document;
        scope.querySelectorAll('.dialog').forEach(rewriteHelpDialog);
    }

    function boot() {
        injectStyle();
        patchAllHelpButtons();
        document.addEventListener('click', onDocumentClickCapture, true);

        const mo = new MutationObserver(muts => {
            if (!isVideoMode()) return;
            for (const m of muts) {
                if (m.type !== 'childList') continue;
                m.addedNodes.forEach(n => {
                    if (n.nodeType !== 1) return;
                    if (n.classList && n.classList.contains('dialog')) rewriteHelpDialog(n);
                    else if (n.querySelectorAll) scanDialogs(n);
                });
            }
            patchAllHelpButtons();
        });
        mo.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['title'],
        });

        scanDialogs(document);
        patchAllHelpButtons();

        setInterval(() => {
            if (isVideoMode()) patchAllHelpButtons();
        }, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();