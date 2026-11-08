import type { ReloadKind } from '../shared/types.ts';
import { getPlayerAndState, getPlayerVideoElement } from './twitch.ts';
import { playerBufferState, runtime, state } from './state.ts';
import { postTwitchWorkerMessage } from './workers.ts';
import { startDriftCorrection } from './drift.ts';
import { PRESERVED_PLAYER_SETTINGS } from './storage.ts';

// iPadOS 13+ reports navigator.platform 'MacIntel' like a Mac; only touch support (Macs report
// maxTouchPoints 0) tells them apart. iPhone/iPod/older iPadOS report their own platform.
const isAppleTouchDevice = (function () {
    try {
        const p = navigator.platform || '';
        if (/^(iPhone|iPad|iPod)/.test(p)) return true;
        return p === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
    } catch {
        return false;
    }
})();
// On Apple touch devices a hard reload's new media element isn't user-gesture-blessed, so iOS
// rejects play(): black frame plus a native play icon to tap. Hard reloads are downgraded to soft.
const iosSoftReload =
    isAppleTouchDevice &&
    (function () {
        try {
            return localStorage.getItem('twitchAdSolutions_iosSoftReload') !== 'false';
        } catch {
            return true;
        }
    })();
export type PlayerTaskOutcome = 'done' | 'skipped-healthy' | 'not-done';

const SCRIPT_PAUSE_RETRY_MS = 10000;

function liveLatency(video: HTMLVideoElement): number | null {
    try {
        if (video.seekable && video.seekable.length > 0) {
            const seekableEnd = video.seekable.end(video.seekable.length - 1);
            if (Number.isFinite(seekableEnd)) {
                const latency = Math.max(0, seekableEnd - video.currentTime);
                // Right after a reload the seekable range can end at garbage; cap at 1h.
                if (latency < 3600) {
                    return latency;
                }
            }
        }
    } catch {}
    return null;
}

export function doTwitchPlayerTask(task: 'pausePlay' | 'reload', reloadKind?: ReloadKind): PlayerTaskOutcome {
    const playerAndState = getPlayerAndState();
    if (!playerAndState) {
        console.log('Could not find react root');
        return 'not-done';
    }
    const player = playerAndState.player;
    const playerState = playerAndState.state;
    if (!player) {
        console.log('Could not find player');
        return 'not-done';
    }
    if (!playerState) {
        console.log('Could not find player state');
        return 'not-done';
    }
    const wasPaused = player.isPaused() || player.core?.paused;
    if (wasPaused) {
        if (playerBufferState.userPauseIntent) {
            if (!playerBufferState.loggedPauseIntent) {
                playerBufferState.loggedPauseIntent = true;
                console.log('[AD DEBUG] Respecting user pause intent — skipping auto-resume');
            }
            return 'not-done';
        }
        // Recently paused/played by us and still paused: autoplay policy may have blocked play().
        if (playerBufferState.scriptPausedAt && Date.now() - playerBufferState.scriptPausedAt < SCRIPT_PAUSE_RETRY_MS) {
            try {
                player.play()?.catch?.(() => {});
            } catch {}
        }
        return 'not-done';
    }
    playerBufferState.scriptPausedAt = 0;
    playerBufferState.lastFixTime = Date.now();
    playerBufferState.stall.frozenTicks = 0;
    if (task === 'pausePlay') {
        player.pause();
        player.play()?.catch?.(() => {});
        playerBufferState.scriptPausedAt = Date.now();
        return 'done';
    }
    if (document.pictureInPictureElement) {
        // setSrc exits PiP.
        player.pause();
        player.play()?.catch?.(() => {});
        console.log('[AD DEBUG] Downgraded reload to pause/play to preserve PiP');
        return 'not-done';
    }
    // Only a reload makes Twitch's player fetch the AVC master, so a codec-swap reload is never skipped.
    const video = player.getHTMLVideoElement?.();
    if (reloadKind !== 'codec-swap' && video && video.readyState >= 3 && !video.paused && !video.ended) {
        const latencySec = liveLatency(video);
        if (latencySec === null) {
            console.log('[AD DEBUG] Latency unknown (seekable unavailable) — proceeding with reload');
        } else if (latencySec > 7) {
            console.log(
                '[AD DEBUG] Player playing but ' +
                    latencySec.toFixed(1) +
                    's behind live — proceeding with reload to reset latency',
            );
        } else {
            console.log(
                '[AD DEBUG] Skipping reload — player healthy (readyState=' +
                    video.readyState +
                    ', playing, latency=' +
                    latencySec.toFixed(1) +
                    's)',
            );
            return 'skipped-healthy';
        }
    }
    const savedSettings = new Map<string, string | null>();
    try {
        for (const { key } of PRESERVED_PLAYER_SETTINGS) {
            savedSettings.set(key, localStorage.getItem(key));
        }
        if (runtime.localStorageHookFailed && player?.core?.state) {
            localStorage.setItem('video-muted', JSON.stringify({ default: player.core.state.muted }));
            localStorage.setItem('volume', String(player.core.state.volume)); // setItem stringifies anyway
        }
        if (player?.core?.state?.quality?.group) {
            localStorage.setItem('video-quality', JSON.stringify({ default: player.core.state.quality.group }));
        }
    } catch {}
    playerBufferState.lastReloadAt = Date.now();
    playerBufferState.adStall = { phase: 'idle' };
    playerBufferState.userPauseIntent = false;
    playerBufferState.loggedPauseIntent = false;
    // A hard reload starts a fresh session, which gets a new ad decision.
    const hardReload = reloadKind === 'early' && !iosSoftReload;
    // Not tied to hardReload: iOS only needs the media instance kept, and leaving autoplay's 360p
    // ladder needs the token refresh, which nothing else would do on iOS.
    const refreshToken = reloadKind === 'early';
    if (reloadKind === 'early' && iosSoftReload) {
        console.log(
            '[AD DEBUG] iOS/iPadOS: downgrading hard reload to soft — keeps media element user-gesture-blessed (avoids black-screen + play-icon stall); access-token refresh is retained, so Source quality can still be restored. Opt-out: twitchAdSolutions_iosSoftReload=false',
        );
    }
    console.log('[AD DEBUG] Reloading Twitch player' + (hardReload ? ' (hard)' : ' (soft)'));
    // Pre-mute through a hard reload: the new MSE initialization crosses a discontinuity and pops.
    if (hardReload) {
        try {
            armMuteRestore();
        } catch {}
    }
    // Twitch dispatches a pause on the old <video> during setSrc, also when a token refresh reuses
    // the media instance; scriptPausedAt keeps it from reading as userPauseIntent, which would block
    // the unmute backstop (issue #200).
    if (hardReload || refreshToken) {
        playerBufferState.scriptPausedAt = Date.now();
    }
    playerState.setSrc({ isNewMediaPlayerInstance: hardReload, refreshAccessToken: refreshToken });
    postTwitchWorkerMessage('TriggeredPlayerReload');
    player.play()?.catch?.(() => {});
    // Chrome's autoplay policy can mute the player on reload, even with no Twitch volume keys saved yet.
    setTimeout(() => {
        try {
            for (const { key, restoreEmpty } of PRESERVED_PLAYER_SETTINGS) {
                const value = savedSettings.get(key);
                if (value != null && (value !== '' || restoreEmpty)) {
                    localStorage.setItem(key, value);
                }
            }
            const video = getPlayerVideoElement();
            // Twitch saves video-muted as '{"default":true}' when the user mutes in its UI.
            const savedMuted = savedSettings.get('video-muted');
            const userIntendedMute = savedMuted && savedMuted.includes('"default":true');
            if (video && video.muted && !userIntendedMute) {
                video.muted = false;
            }
            if (video && video.buffered.length > 0 && video.readyState >= 3) {
                const liveEdge = video.buffered.end(video.buffered.length - 1);
                const drift = liveEdge - video.currentTime;
                if (hardReload && drift > 5 && Number.isFinite(liveEdge) && liveEdge < 3600) {
                    console.log(
                        '[AD DEBUG] Post-hard-reload seek to live — ' +
                            drift.toFixed(1) +
                            's behind, jumping to live edge to flush A/V drift',
                    );
                    video.currentTime = liveEdge;
                } else if (drift > 2) {
                    console.log('[AD DEBUG] Post-reload live drift correction: ' + drift.toFixed(1) + 's behind');
                    startDriftCorrection(video);
                }
            }
        } catch {}
    }, 3000);
    return 'done';
}

interface MuteRestore {
    phase: 'awaiting-media' | 'backstop';
    premuted: HTMLVideoElement[];
    cancel(): void;
}
let muteRestore: MuteRestore | null = null;

function armMuteRestore() {
    const prev = muteRestore;
    prev?.cancel();
    muteRestore = null;
    const v = getPlayerVideoElement();
    if (!v) return;
    const premuted = prev && prev.phase === 'awaiting-media' ? prev.premuted.slice() : [];
    const wasInitiallyUnmuted = !v.muted || premuted.includes(v);
    // Issue #200: Twitch silently re-mutes after reloads, so once vaft has unmuted this session an
    // already-muted element is treated as that re-mute, not the user's.
    const shouldRecover = playerBufferState.vaftEverUnmuted && state.RecoverFromSilentMute;
    if (!wasInitiallyUnmuted && !shouldRecover) return;
    if (!v.muted) {
        v.muted = true;
        premuted.push(v);
    }
    // `cur` may not be the element we muted: Twitch adds ad <video>s (#249), and Firefox's built-in
    // PiP never sets document.pictureInPictureElement, so the PiP reload guard doesn't fire there (#248).
    const clearLeakedPremutes = (cur: HTMLVideoElement | null, where: string) => {
        for (const el of premuted) {
            if (el !== cur && el.isConnected && el.muted) {
                el.muted = false;
                console.log(
                    '[AD DEBUG] ' +
                        where +
                        ' — cleared leaked pre-mute on the original element (cur resolved to a different <video>) — issue #248',
                );
            }
        }
    };
    // setSrc({isNewMediaPlayerInstance:true}) replaces the <video>, so a listener on `v` never fires:
    // listen on document for whichever <video> gets the new MediaSource. Edge fires loadeddata and
    // playing independently of canplay.
    const listener = (e: Event) => {
        if (e.target && (e.target as Element).tagName === 'VIDEO') restore();
    };
    const removeListeners = () => {
        document.removeEventListener('canplay', listener, true);
        document.removeEventListener('playing', listener, true);
        document.removeEventListener('loadeddata', listener, true);
    };
    const restore = () => {
        if (instance.phase !== 'awaiting-media') return;
        instance.phase = 'backstop';
        removeListeners();
        clearTimeout(restoreTimer);
        try {
            const cur = getPlayerVideoElement();
            if (cur) {
                cur.muted = false;
                playerBufferState.vaftEverUnmuted = true;
            }
            clearLeakedPremutes(cur, 'Restore');
        } catch {}
    };
    // Twitch's own localStorage restore (~3000ms) can re-mute the player. Twitch's player correlates
    // pause and mute, so userPauseIntent stands in for a deliberate mute.
    const backstop = () => {
        restore();
        if (muteRestore === instance) muteRestore = null;
        try {
            const cur = getPlayerVideoElement();
            if (cur && cur.muted) {
                if (playerBufferState.userPauseIntent) {
                    console.log(
                        '[AD DEBUG] Hard reload backstop SKIPPED — element muted at 5500ms but userPauseIntent set (likely false-positive pause event during MSE teardown — issue #200 follow-up)',
                    );
                } else {
                    cur.muted = false;
                    playerBufferState.vaftEverUnmuted = true;
                    console.log(
                        '[AD DEBUG] Hard reload backstop unmute fired — element was still muted at 5500ms (initial: ' +
                            (wasInitiallyUnmuted
                                ? 'unmuted, we pre-muted'
                                : 'already-muted on entry — recovering from silent Twitch re-mute') +
                            ')',
                    );
                }
            }
            if (wasInitiallyUnmuted && !playerBufferState.userPauseIntent) {
                clearLeakedPremutes(cur, 'Backstop');
            }
        } catch {}
    };
    document.addEventListener('canplay', listener, true);
    document.addEventListener('playing', listener, true);
    document.addEventListener('loadeddata', listener, true);
    // 4000ms: Edge's MSE initialization is slow (issue #200).
    const restoreTimer = setTimeout(restore, 4000);
    const backstopTimer = setTimeout(backstop, 5500);
    const instance: MuteRestore = {
        phase: 'awaiting-media',
        premuted,
        cancel() {
            removeListeners();
            clearTimeout(restoreTimer);
            clearTimeout(backstopTimer);
        },
    };
    muteRestore = instance;
}
