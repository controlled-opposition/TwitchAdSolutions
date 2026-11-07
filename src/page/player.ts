import type { ReloadKind } from '../shared/types.ts';
import { getPlayerAndState, getPlayerVideoElement } from './twitch.ts';
import { playerBufferState, runtime, state } from './state.ts';
import { postTwitchWorkerMessage } from './workers.ts';
import { startDriftCorrection } from './drift.ts';

// Apple touch-device detection. iPadOS 13+ reports navigator.platform 'MacIntel' with a desktop
// Safari UA — distinguished from a real Mac only by touch support (real Macs report maxTouchPoints 0).
// iPhone/iPod/older iPadOS report platform directly.
const isAppleTouchDevice = (function () {
    try {
        const p = navigator.platform || '';
        if (/^(iPhone|iPad|iPod)/.test(p)) return true;
        return p === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
    } catch {
        return false;
    }
})();
// On Apple touch devices a hard reload re-instantiates the media element (setSrc isNewMediaPlayerInstance),
// which iOS/iPadOS treats as not user-gesture-"blessed" → play() is rejected → black frame + native play
// icon the user must tap (issue: iPad ad black-screen). Downgrade hard reloads to soft so the existing
// blessed element is reused and resumes without a tap. Opt-out: twitchAdSolutions_iosSoftReload=false.
const iosSoftReload =
    isAppleTouchDevice &&
    (function () {
        try {
            return localStorage.getItem('twitchAdSolutions_iosSoftReload') !== 'false';
        } catch {
            return true;
        }
    })();
// Pause/play or fully reload the Twitch player, preserving quality/volume settings
export function doTwitchPlayerTask(task: 'pausePlay' | 'reload', reloadKind?: ReloadKind) {
    const playerAndState = getPlayerAndState();
    if (!playerAndState) {
        console.log('Could not find react root');
        return;
    }
    const player = playerAndState.player;
    const playerState = playerAndState.state;
    if (!player) {
        console.log('Could not find player');
        return;
    }
    if (!playerState) {
        console.log('Could not find player state');
        return;
    }
    const wasPaused = player.isPaused() || player.core?.paused;
    if (wasPaused) {
        // User deliberately paused — respect their intent, don't auto-resume
        if (playerBufferState.userPauseIntent) {
            if (!playerBufferState.loggedPauseIntent) {
                playerBufferState.loggedPauseIntent = true;
                console.log('[AD DEBUG] Respecting user pause intent — skipping auto-resume');
            }
            return;
        }
        // If WE recently called pause/play and player is still paused, retry play (stuck from autoplay policy or ad-state interference)
        if (playerBufferState.weJustPaused && Date.now() - playerBufferState.weJustPaused < 10000) {
            try {
                player.play()?.catch?.(() => {});
            } catch {}
        }
        return;
    }
    playerBufferState.weJustPaused = 0;
    playerBufferState.lastFixTime = Date.now();
    playerBufferState.numSame = 0;
    if (task === 'pausePlay') {
        player.pause();
        player.play()?.catch?.(() => {});
        playerBufferState.weJustPaused = Date.now();
        return;
    }
    if (document.pictureInPictureElement) {
        // Downgrade to pause/play to preserve PiP — setSrc exits PiP
        player.pause();
        player.play()?.catch?.(() => {});
        console.log('[AD DEBUG] Downgraded reload to pause/play to preserve PiP');
        return;
    }
    // Skip reload if the player is already healthy — avoids disrupting smooth playback.
    // But if we're way behind live edge (e.g. after a long ad break), proceed with reload to reset latency.
    const video = player.getHTMLVideoElement?.();
    if (video && video.readyState >= 3 && !video.paused && !video.ended) {
        let latencySec = 0;
        let latencyKnown = false;
        try {
            if (video.seekable && video.seekable.length > 0) {
                const seekableEnd = video.seekable.end(video.seekable.length - 1);
                if (Number.isFinite(seekableEnd)) {
                    const calc = Math.max(0, seekableEnd - video.currentTime);
                    // Sanity cap: values >1h indicate garbage from the Media Source API
                    // (seen right after a reload while the seekable range is in a transient state).
                    if (calc < 3600) {
                        latencySec = calc;
                        latencyKnown = true;
                    }
                }
            }
        } catch {}
        if (!latencyKnown) {
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
            postTwitchWorkerMessage('ReloadSkipped');
            return;
        }
    }
    const lsKeyQuality = 'video-quality';
    const lsKeyMuted = 'video-muted';
    const lsKeyVolume = 'volume';
    const lsKeyLowLatency = 'lowLatencyModeEnabled'; // Preserve user's low-latency toggle across reloads (TTV-AB parity)
    const lsKeyPersistence = 'persistenceEnabled'; // Preserve autoplay/persistence toggle across reloads (TTV-AB parity)
    let currentQualityLS = null;
    let currentMutedLS = null;
    let currentVolumeLS = null;
    let currentLowLatencyLS = null;
    let currentPersistenceLS = null;
    try {
        currentQualityLS = localStorage.getItem(lsKeyQuality);
        currentMutedLS = localStorage.getItem(lsKeyMuted);
        currentVolumeLS = localStorage.getItem(lsKeyVolume);
        currentLowLatencyLS = localStorage.getItem(lsKeyLowLatency);
        currentPersistenceLS = localStorage.getItem(lsKeyPersistence);
        if (runtime.localStorageHookFailed && player?.core?.state) {
            localStorage.setItem(lsKeyMuted, JSON.stringify({ default: player.core.state.muted }));
            localStorage.setItem(lsKeyVolume, String(player.core.state.volume)); // setItem stringifies anyway
        }
        if (player?.core?.state?.quality?.group) {
            localStorage.setItem(lsKeyQuality, JSON.stringify({ default: player.core.state.quality.group }));
        }
    } catch {}
    playerBufferState.lastReloadAt = Date.now();
    playerBufferState.adStallStartAt = 0; // clear stale stall timer so post-reload readyState=0 isn't attributed to pre-reload stall
    playerBufferState.userPauseIntent = false;
    playerBufferState.loggedPauseIntent = false;
    // playerForMonitoringBuffering re-acquired fresh every tick — no manual invalidation needed
    // Hard reload for 'early' (mid-break escape — fresh session gets new ad-decision bucket).
    // Soft reload for 'post-ad' (smooth transition, no black screen teardown).
    // Apple touch devices: force soft — a new media instance needs a user tap to resume (black-screen + play icon).
    const hardReload = reloadKind === 'early' && !iosSoftReload;
    // Decoupled from hardReload on purpose. The iOS downgrade below exists to keep the
    // media element user-gesture-blessed, which only requires skipping the new media
    // instance — not the token refresh. An 'early' reload after an autoplay commit
    // depends on refreshAccessToken to leave the autoplay-scoped 360p variant ladder;
    // without it an iOS user stays pinned at 360p, since 'early' is always downgraded
    // here and 'post-ad' is soft by definition, so nothing refreshes the token again.
    const refreshToken = reloadKind === 'early';
    if (reloadKind === 'early' && iosSoftReload) {
        console.log(
            '[AD DEBUG] iOS/iPadOS: downgrading hard reload to soft — keeps media element user-gesture-blessed (avoids black-screen + play-icon stall); access-token refresh is retained, so Source quality can still be restored. Opt-out: twitchAdSolutions_iosSoftReload=false',
        );
    }
    console.log('[AD DEBUG] Reloading Twitch player' + (hardReload ? ' (hard)' : ' (soft)'));
    // Pre-mute through hard reload to hide the MediaSource-teardown audio click.
    // New MSE initialization crosses a discontinuity boundary that produces an
    // audible pop on first frames. Restored on `canplay` (audio decodable) with a
    // 1500ms safety cap. Skipped if user was already muted (preserves intent).
    // Existing 3000ms LS-restore timer below acts as ultimate backstop.
    if (hardReload) {
        try {
            const v = getPlayerVideoElement();
            const wasInitiallyUnmuted = v && !v.muted;
            // Issue #200 fix: also set up restore+backstop when the element is already
            // muted IF vaft has successfully unmuted at any point earlier this session.
            // Strong signal of Twitch's silent re-mute pattern (confirmed via v633
            // diagnostic logs) rather than user-initiated mute. Without this, AFK
            // users come back to persistently-muted streams (Tgod1991 on v635). First-
            // session-mute users have vaftEverUnmuted=false → backstop never engages
            // → mute respected. Disabled by twitchAdSolutions_recoverFromSilentMute=
            // false for users who deliberately mute mid-session.
            const shouldRecover = playerBufferState.vaftEverUnmuted && state.RecoverFromSilentMute;
            if (v && (wasInitiallyUnmuted || shouldRecover)) {
                if (wasInitiallyUnmuted) {
                    v.muted = true;
                }
                // setSrc({isNewMediaPlayerInstance:true}) replaces the <video> element,
                // so a listener on the original `v` never fires — events fire on the
                // new element. Listen on document (capture phase) instead so we catch
                // them regardless of which <video> Twitch attaches the new MediaSource
                // to. Three event triggers are wired up because Edge dispatches
                // `loadeddata` / `playing` independently of `canplay` and any of them
                // is sufficient signal that the new element is ready for unmute.
                // First-fired wins via the idempotent `done` guard.
                let done = false;
                const restore = () => {
                    if (done) return;
                    done = true;
                    document.removeEventListener('canplay', listener, true);
                    document.removeEventListener('playing', listener, true);
                    document.removeEventListener('loadeddata', listener, true);
                    try {
                        const cur = getPlayerVideoElement();
                        if (cur) {
                            cur.muted = false;
                            playerBufferState.vaftEverUnmuted = true;
                        }
                        // Undo OUR pre-mute if it landed on a different element than `cur`.
                        // `cur` is whichever <video> is first in the DOM — not necessarily the one
                        // we muted, now that Twitch renders extra <video> elements for side/chat
                        // ads (#249), and Firefox's PiP is browser-native so the
                        // document.pictureInPictureElement reload guard never fires there (#248).
                        // Gated on wasInitiallyUnmuted so it only ever clears a mute we set —
                        // it can never unmute an ad video. No-op on a normal hard reload, where
                        // the old element is disconnected.
                        if (v && v !== cur && v.isConnected && v.muted && wasInitiallyUnmuted) {
                            v.muted = false;
                            console.log(
                                '[AD DEBUG] Restore — cleared leaked pre-mute on the original element (cur resolved to a different <video>) — issue #248',
                            );
                        }
                    } catch {}
                };
                const listener = (e: Event) => {
                    if (e.target && (e.target as Element).tagName === 'VIDEO') restore();
                };
                document.addEventListener('canplay', listener, true);
                document.addEventListener('playing', listener, true);
                document.addEventListener('loadeddata', listener, true);
                setTimeout(restore, 4000); // Bumped 2500ms → 4000ms for Edge slow-init slack — issue #200 follow-up reports muted state on hard reloads where MSE init exceeded 2500ms.
                // Final backstop: if the player ends up muted at 5500ms despite our
                // restore (Twitch's own LS-restore at ~3000ms can re-mute if the
                // captured pre-reload muted snapshot was true), force one more
                // unmute. Idempotent — no-op if already unmuted. Skipped if the user
                // explicitly muted (`weJustPaused` paths preserve user-mute intent;
                // checking `playerBufferState.userPauseIntent` here is a cheap proxy
                // — pause+mute are conceptually correlated by Twitch's player code).
                setTimeout(() => {
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
                        // Same leaked-pre-mute catch as in restore(), at the backstop — see #248.
                        if (
                            v &&
                            v !== cur &&
                            v.isConnected &&
                            v.muted &&
                            wasInitiallyUnmuted &&
                            !playerBufferState.userPauseIntent
                        ) {
                            v.muted = false;
                            console.log(
                                '[AD DEBUG] Backstop — cleared leaked pre-mute on the original element (cur resolved to a different <video>) — issue #248',
                            );
                        }
                    } catch {}
                }, 5500);
            }
        } catch {}
    }
    // Set weJustPaused so the pause-listener filters out the MSE-teardown
    // pause event that Twitch dispatches on the old <video> during setSrc.
    // Without this, userPauseIntent would falsely flip to true during the
    // reload window, blocking the 5500ms backstop's unmute on stuck-muted
    // recovery (issue #200 follow-up). Reuses the existing 2s pause-listener
    // guard.
    // refreshToken as well as hardReload: a token refresh swaps the source even when
    // the media instance is reused (the iOS downgrade), so Twitch can still dispatch
    // the teardown pause. Unarmed, that reads as userPauseIntent and suppresses the
    // unmute backstop — muted stream on exactly the devices this path targets.
    if (hardReload || refreshToken) {
        playerBufferState.weJustPaused = Date.now();
    }
    playerState.setSrc({ isNewMediaPlayerInstance: hardReload, refreshAccessToken: refreshToken });
    postTwitchWorkerMessage('TriggeredPlayerReload');
    player.play()?.catch?.(() => {});
    // Always restore muted/volume state after reload — Chrome autoplay policy can force muted.
    // Block must always run: if Twitch hasn't written LS values yet (fresh session, private mode,
    // cleared cache), the video still needs unmute after Chrome's autoplay mute on reload.
    setTimeout(() => {
        try {
            if (currentQualityLS) {
                localStorage.setItem(lsKeyQuality, currentQualityLS);
            }
            if (currentMutedLS) {
                localStorage.setItem(lsKeyMuted, currentMutedLS);
            }
            if (currentVolumeLS) {
                localStorage.setItem(lsKeyVolume, currentVolumeLS);
            }
            if (currentLowLatencyLS !== null) {
                localStorage.setItem(lsKeyLowLatency, currentLowLatencyLS);
            }
            if (currentPersistenceLS !== null) {
                localStorage.setItem(lsKeyPersistence, currentPersistenceLS);
            }
            // The player's own element, not a separate Twitch ad <video> (#249).
            const video = getPlayerVideoElement();
            // Respect user's mute intent: only force-unmute if LS didn't say mute.
            // Twitch writes video-muted as '{"default":true}' when user muted via UI;
            // Chrome autoplay policy can mute even if user didn't (no LS signal).
            const userIntendedMute = currentMutedLS && currentMutedLS.includes('"default":true');
            if (video && video.muted && !userIntendedMute) {
                video.muted = false;
            }
            // Correct live drift after reload.
            // For hard reload with large drift (>5s), hard-seek to live edge to flush
            // any A/V timestamp desync from strip+BLANK_MP4+recovery activity. Drift
            // correction at 1.1x would take minutes to catch up 30-60s of drift.
            // For soft reload or small drift, use existing gradual catch-up.
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
}
