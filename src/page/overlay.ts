import type { AdBlockBannerMessage } from '../shared/types.ts';
import { playerBufferState, runtime } from './state.ts';

// Cached #root DOM element (never changes in React SPAs)
let cachedPlayerRootDiv: HTMLElement | null = null;
// Cached .video-player element
// One-shot flags for overlay-hide logs. Twitch's React tree re-mounts SDA
// wrappers and ad-break cards constantly during an ad break, so the
// hide-and-log fires hundreds of times. Log the first occurrence of each
// hide type per page load, then stay silent — the hide itself still runs
// on every tick via dataset-based dedup.
let loggedSdaHide = false;
// Hide Twitch's ad break / Turbo promo / stream display ad overlays when we're already blocking ads
export function hideTwitchAdOverlays() {
    if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) return;
    // Hide stream display ad (SDA) wrapper
    const sdaElements = document.querySelectorAll('[data-test-selector="sda-wrapper"]') as NodeListOf<HTMLElement>;
    for (let i = 0; i < sdaElements.length; i++) {
        if (!sdaElements[i].dataset.tasHidden) {
            sdaElements[i].dataset.tasHidden = '';
            sdaElements[i].style.setProperty('display', 'none', 'important');
            if (!loggedSdaHide) {
                loggedSdaHide = true;
                console.log('[AD DEBUG] Hidden Twitch stream display ad');
            }
        }
    }
    // Separate video-ad guard (mirrors GosuDRM/TTV-AB v12.0.1-12.0.8 — issue #249): since
    // July 2026 Twitch renders standalone <video> ad elements beside the player and in chat
    // — a second "player" with a Play-ad button. They are delivered outside the m3u8, so
    // neither segment stripping nor backup-swapping touches them.
    // Matched ONLY on the Amazon ad-CDN host. That is the safety property: the live stream is
    // fed by MediaSource and always carries a blob: URL, so the primary player can never match
    // this test. The player-owned element is skipped as a second, independent guard.
    // Muted + paused as well as hidden — a display:none <video> still plays audio (TTV-AB v12.0.7).
    const primaryVideo = runtime.playerForMonitoringBuffering?.player?.getHTMLVideoElement?.();
    const allVideos = document.getElementsByTagName('video');
    for (let i = 0; i < allVideos.length; i++) {
        const vid = allVideos[i];
        let adHost = '';
        try {
            const vidSrc = vid.currentSrc || vid.getAttribute('src') || '';
            if (vidSrc && !vidSrc.startsWith('blob:')) {
                const host = new URL(vidSrc, document.location.href).hostname.toLowerCase();
                if (host === 'media-amazon.com' || host.endsWith('.media-amazon.com')) {
                    adHost = host;
                }
            }
        } catch {}
        if (adHost && vid !== primaryVideo) {
            // Re-assert every tick rather than marking once: a React re-render can drop the
            // inline style while keeping the element, and a one-shot marker would never re-hide it.
            vid.style.setProperty('display', 'none', 'important');
            try {
                vid.muted = true;
                if (!vid.paused) vid.pause();
            } catch {}
            if (!vid.dataset.tasAdHidden) {
                // '1', not '': dataset returns the empty string as-is, which is falsy —
                // the dedup, the restore branch and getPlayerVideoElement() would all misread it.
                vid.dataset.tasAdHidden = '1';
                console.log('[AD DEBUG] Hidden separate Twitch video ad (' + adHost + ') — issue #249');
            }
        } else if (vid.dataset.tasAdHidden && !adHost) {
            // Twitch RECYCLES <video> nodes: an element that held an ad can later be handed real
            // content. Without this it would stay display:none + muted forever — invisible content.
            // Deliberately not gated on the primary check, so an element promoted to primary is
            // still restored. Mirrors TTV-AB v12.0.2 ("safely restores videos that Twitch reuses").
            delete vid.dataset.tasAdHidden;
            vid.style.removeProperty('display');
            try {
                vid.muted = false;
            } catch {}
            console.log('[AD DEBUG] Restored recycled <video> — source is no longer an ad (#249)');
        }
    }
}
export function updateAdblockBanner(data: Partial<AdBlockBannerMessage> & { hasAds: boolean }) {
    if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) {
        cachedPlayerRootDiv = document.querySelector('.video-player');
    }
    const playerRootDiv = cachedPlayerRootDiv;
    if (playerRootDiv != null) {
        let adBlockDiv: (HTMLElement & { P?: HTMLParagraphElement | null }) | null = null;
        adBlockDiv = playerRootDiv.querySelector('.tas-adblock-overlay');
        if (adBlockDiv == null) {
            adBlockDiv = document.createElement('div') as HTMLElement & { P?: HTMLParagraphElement | null };
            adBlockDiv.className = 'tas-adblock-overlay';
            adBlockDiv.innerHTML =
                '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
            adBlockDiv.style.display = 'none';
            adBlockDiv.P = adBlockDiv.querySelector('p');
            playerRootDiv.appendChild(adBlockDiv);
        }
        if (adBlockDiv != null) {
            runtime.isActivelyStrippingAds = !!data.isStrippingAdSegments;
            // The worker sends this on every playlist poll (~2s), mostly unchanged. Write only what
            // changed: each textContent assignment replaces the text node and wakes every
            // MutationObserver on the page (Twitch's and other extensions').
            // P is missing if the overlay was created by another (older/duplicate) copy of the script.
            if (adBlockDiv.P) {
                const text =
                    'Blocking' +
                    (data.isMidroll ? ' midroll' : '') +
                    ' ads' +
                    (data.isStrippingAdSegments ? ' (stripping)' : '') +
                    (data.activeBackupPlayerType ? ' (' + data.activeBackupPlayerType + ')' : '');
                if (adBlockDiv.P.textContent !== text) {
                    adBlockDiv.P.textContent = text;
                }
            }
            const display = data.hasAds && playerBufferState.isLive ? 'block' : 'none';
            if (adBlockDiv.style.display !== display) {
                adBlockDiv.style.display = display;
            }
        }
        if (data.hasAds) {
            hideTwitchAdOverlays();
        }
    }
}
