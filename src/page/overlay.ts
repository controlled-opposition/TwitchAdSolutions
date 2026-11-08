import type { AdBlockBannerMessage } from '../shared/types.ts';
import { playerBufferState, runtime } from './state.ts';

let cachedPlayerRootDiv: HTMLElement | null = null;
// Twitch re-mounts SDA wrappers constantly during a break; log only the first hide per page load.
let loggedSdaHide = false;
export function hideTwitchAdOverlays() {
    if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) return;
    const sdaElements = document.querySelectorAll('[data-test-selector="sda-wrapper"]') as NodeListOf<HTMLElement>;
    for (let i = 0; i < sdaElements.length; i++) {
        const style = sdaElements[i].style;
        // Checks the style itself rather than a marker, because a React re-render can drop the inline style.
        if (style.getPropertyValue('display') !== 'none' || style.getPropertyPriority('display') !== 'important') {
            style.setProperty('display', 'none', 'important');
            if (!loggedSdaHide) {
                loggedSdaHide = true;
                console.log('[AD DEBUG] Hidden Twitch stream display ad');
            }
        }
    }
    // Since July 2026 Twitch renders standalone <video> ads beside the player and in chat (#249),
    // outside the m3u8. Matched only on the Amazon ad-CDN host: the live stream plays from a
    // MediaSource blob: URL, so the player can't match. Muted and paused too: a display:none
    // <video> still plays audio.
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
            // A React re-render can drop the inline style while keeping the element.
            vid.style.setProperty('display', 'none', 'important');
            try {
                vid.muted = true;
                if (!vid.paused) vid.pause();
            } catch {}
            if (!vid.dataset.tasAdHidden) {
                vid.dataset.tasAdHidden = '1';
                console.log('[AD DEBUG] Hidden separate Twitch video ad (' + adHost + ') — issue #249');
            }
        } else if (vid.dataset.tasAdHidden && !adHost) {
            // Twitch reuses <video> nodes: one that held an ad can later get real content, even as the
            // player's own element.
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
        let adBlockDiv: (HTMLElement & { P?: HTMLParagraphElement | null }) | null =
            playerRootDiv.querySelector('.tas-adblock-overlay');
        if (adBlockDiv == null) {
            adBlockDiv = document.createElement('div') as HTMLElement & { P?: HTMLParagraphElement | null };
            adBlockDiv.className = 'tas-adblock-overlay';
            adBlockDiv.innerHTML =
                '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
            adBlockDiv.style.display = 'none';
            adBlockDiv.P = adBlockDiv.querySelector('p');
            playerRootDiv.appendChild(adBlockDiv);
        }
        // Sent every playlist poll (~2s), mostly unchanged: each textContent write replaces the text
        // node and wakes every MutationObserver on the page.
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
        if (data.hasAds) {
            hideTwitchAdOverlays();
        }
    }
}
