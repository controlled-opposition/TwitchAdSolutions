import { getPlayerAndState } from './twitch.ts';
import { playerBufferState, runtime, state } from './state.ts';
import { startDriftCorrection } from './drift.ts';
import { doTwitchPlayerTask } from './player.ts';
import { hideTwitchAdOverlays, updateAdblockBanner } from './overlay.ts';

// Grace windows after a player reload and after a backup stream switch (start or end of an ad
// break): the stall fixes stand down while the player settles.
const RELOAD_GRACE_MS = 15000;
const BACKUP_SWITCH_GRACE_MS = 10000;
/** Whether timestamp `at` is set and less than `ms` ago. */
function within(at: number, ms: number): boolean {
    return !!at && Date.now() - at < ms;
}
/** Start a fresh recovery window: no stall seen, no fix attempted, reload budget restored. */
function resetStallRecovery() {
    playerBufferState.numSame = 0;
    playerBufferState.fixAttempts = 0;
    playerBufferState.recoveryReloadUsed = false;
}
// Visibility listener: installed once; pendingTick dedupes the immediate tick it schedules.
let visibilityHooked = false;
let pendingTick = false;
// Poll the player state to detect and fix buffering caused by ad stream switching
export function monitorPlayerBuffering() {
    // Fresh player lookup every tick (avoids stale ref when Twitch restarts its own player)
    runtime.playerForMonitoringBuffering = null;
    {
        const playerAndState = getPlayerAndState();
        if (playerAndState && playerAndState.player && playerAndState.state) {
            runtime.playerForMonitoringBuffering = {
                player: playerAndState.player,
                state: playerAndState.state,
            };
            const video = playerAndState.player.getHTMLVideoElement?.();
            if (video && !video.__tasIntentHooked) {
                video.__tasIntentHooked = true;
                video.addEventListener('pause', () => {
                    if (!playerBufferState.weJustPaused || Date.now() - playerBufferState.weJustPaused > 2000) {
                        playerBufferState.userPauseIntent = true;
                    }
                });
                video.addEventListener('play', () => {
                    playerBufferState.userPauseIntent = false;
                    playerBufferState.loggedPauseIntent = false;
                });
            }
        }
    }
    if (runtime.playerForMonitoringBuffering) {
        try {
            const player = runtime.playerForMonitoringBuffering.player;
            const twitchState = runtime.playerForMonitoringBuffering.state;
            if (!player.core) {
                runtime.playerForMonitoringBuffering = null;
            } else if (
                twitchState.props?.content?.type === 'live' &&
                !player.isPaused() &&
                !player.getHTMLVideoElement()?.ended &&
                (player.getHTMLVideoElement()?.readyState ?? 0) >= 1 &&
                playerBufferState.lastFixTime <= Date.now() - state.PlayerBufferingMinRepeatDelay &&
                !runtime.isActivelyStrippingAds &&
                !playerBufferState.inAdBreak &&
                !within(playerBufferState.lastReloadAt, RELOAD_GRACE_MS) &&
                !within(playerBufferState.lastBackupSwitchAt, BACKUP_SWITCH_GRACE_MS)
            ) {
                const m3u8Url = player.core?.state?.path;
                if (m3u8Url) {
                    const lastSlash = m3u8Url.lastIndexOf('/');
                    const queryStart = m3u8Url.indexOf('?', lastSlash);
                    const fileName = m3u8Url.substring(lastSlash + 1, queryStart !== -1 ? queryStart : undefined);
                    if (fileName?.endsWith('.m3u8')) {
                        const channelName = fileName.slice(0, -5);
                        if (playerBufferState.channelName !== channelName) {
                            playerBufferState.channelName = channelName;
                            playerBufferState.hasStreamStarted = false;
                            resetStallRecovery();
                            playerBufferState.userPauseIntent = false;
                            playerBufferState.loggedPauseIntent = false;
                        }
                    }
                }
                if (player.getState() === 'Playing') {
                    playerBufferState.hasStreamStarted = true;
                }
                const position = player.core?.state?.position;
                const bufferedPosition = player.core?.state?.bufferedPosition;
                const bufferDuration = player.getBufferDuration();
                // video.currentTime is the source of truth for actual playback progress —
                // player.core.state.position updates in batches on reload-heavy channels
                // (see PR #183 commit msg), so it can appear frozen for ~12s even while
                // the video element is advancing smoothly. Used in the stall trigger below
                // alongside state.position so a real stall (BOTH frozen) is required to
                // fire, not just a batch-update lull in state.position.
                const videoEl = player.getHTMLVideoElement?.();
                const videoCurrentTime = videoEl?.currentTime;
                if (position !== undefined && bufferedPosition !== undefined) {
                    // NOTE: This could be improved. It currently lets the player fully eat the full buffer before it triggers pause/play
                    // Skip the buffer-stall check entirely while the <video> element isn't actively
                    // trying to play. Two states this catches:
                    //   readyState < 2 (HAVE_CURRENT_DATA) — MSE init / seek in flight / fresh post-
                    //     reload load. currentTime and state.position are both genuinely 0 here, but
                    //     it's an initialization state, not a stall — escalating would loop reloads.
                    //   videoEl.paused === true — the outer block already gates on
                    //     player.isPaused()===false, but the IVS player wrapper and the underlying
                    //     <video>.paused can disagree briefly during reload teardown / autoplay-policy
                    //     mute toggles. When <video>.paused is true the player isn't trying to play
                    //     so "stalled" is the wrong word.
                    // Hold counters (don't increment, don't reset): a real stall sequence interrupted
                    // by a brief init dip resumes counting on the next active poll.
                    const playerNotActivelyPlaying = videoEl && (videoEl.readyState < 2 || videoEl.paused);
                    // FFZ's audio compressor wraps player.load() and creates a fresh <video>
                    // element on every load (src/sites/shared/player.jsx replaceVideoElement).
                    // Twitch's playback-monitor then snaps the new element to "buffered region
                    // 0.04xxx" while the buffer rebuilds. During that brief ramp-up window,
                    // currentTime plateaus and state.position is also at its post-reload reset
                    // — exactly the positionFrozen pattern. Detect the swap by element identity
                    // and treat it like a fresh reload (clear counters, set the recovery flag
                    // so the next active poll grants grace).
                    if (videoEl && playerBufferState.videoElement && playerBufferState.videoElement !== videoEl) {
                        resetStallRecovery();
                    }
                    playerBufferState.videoElement = videoEl;
                    // Stall trigger: position-frozen check now requires BOTH state.position
                    // AND video.currentTime unchanged. If currentTime is advancing the player
                    // is playing fine and we should not "fix" anything — the false-fires
                    // were causing user-visible 8s-cadence abrupts on low-latency / post-
                    // quality-change states.
                    const positionFrozen =
                        playerBufferState.position === position &&
                        (playerBufferState.videoCurrentTime === undefined ||
                            playerBufferState.videoCurrentTime === videoCurrentTime);
                    if (playerNotActivelyPlaying) {
                        // Skip — neither increment nor reset, just hold state.
                    } else if (
                        playerBufferState.hasStreamStarted &&
                        (!state.PlayerBufferingPrerollCheckEnabled ||
                            position > state.PlayerBufferingPrerollCheckOffset) &&
                        // Tighten to AND: a real stall is BOTH frozen position AND a draining buffer.
                        // Field reports on Firefox at live edge showed the OR form firing during normal
                        // thin-buffer breathing (~1-2s buffered, currentTime briefly idle waiting on a
                        // segment fetch) — pause/play would then knock the player back to readyState=1
                        // and currentTime=0, snowballing into a self-reinforcing reload cascade. With
                        // AND, real stalls (frozen + buffer drained below DangerZone) still fire on the
                        // same poll cadence; healthy thin-buffer feeds no longer trip it.
                        positionFrozen &&
                        bufferDuration < state.PlayerBufferingDangerZone &&
                        playerBufferState.bufferedPosition === bufferedPosition &&
                        playerBufferState.bufferDuration >= bufferDuration &&
                        (position !== 0 || bufferedPosition !== 0 || bufferDuration !== 0)
                    ) {
                        playerBufferState.numSame++;
                        if (playerBufferState.numSame === state.PlayerBufferingSameStateCount) {
                            playerBufferState.fixAttempts++;
                            // Cap: at most ONE reload per recovery window. After reloading once,
                            // stay on pause/play until playback recovers. Prevents reload cascades.
                            const wouldEscalate = playerBufferState.fixAttempts >= 3;
                            const escalateToReload =
                                wouldEscalate && (state.DisableReloadCap || !playerBufferState.recoveryReloadUsed);
                            const reloadCapNote =
                                wouldEscalate && !escalateToReload
                                    ? ' (reload cap reached, pause/play only — set twitchAdSolutions_disableReloadCap=true to bypass)'
                                    : escalateToReload
                                      ? ' (escalating to reload)'
                                      : '';
                            console.log(
                                'Attempt to fix buffering position:' +
                                    playerBufferState.position +
                                    ' bufferedPosition:' +
                                    playerBufferState.bufferedPosition +
                                    ' bufferDuration:' +
                                    playerBufferState.bufferDuration +
                                    reloadCapNote,
                            );
                            // Seek past buffer gap instead of stalling + drift to recover
                            const video = player.getHTMLVideoElement?.();
                            if (video && video.buffered.length > 1) {
                                for (let bi = 0; bi < video.buffered.length; bi++) {
                                    if (video.buffered.start(bi) > video.currentTime + 0.5) {
                                        console.log(
                                            '[AD DEBUG] Seeking past ' +
                                                (video.buffered.start(bi) - video.currentTime).toFixed(1) +
                                                's buffer gap',
                                        );
                                        video.currentTime = video.buffered.start(bi);
                                        startDriftCorrection(video);
                                        break;
                                    }
                                }
                            }
                            if (video) {
                                console.log(
                                    '[AD DEBUG] Video state: readyState=' +
                                        video.readyState +
                                        ' networkState=' +
                                        video.networkState +
                                        ' buffered=' +
                                        (video.buffered.length > 0
                                            ? video.buffered.end(video.buffered.length - 1).toFixed(1)
                                            : 0) +
                                        ' currentTime=' +
                                        video.currentTime.toFixed(1) +
                                        ' paused=' +
                                        video.paused,
                                );
                            }
                            doTwitchPlayerTask(
                                escalateToReload || state.PlayerBufferingDoPlayerReload ? 'reload' : 'pausePlay',
                            );
                            playerBufferState.lastFixTime = Date.now();
                            playerBufferState.numSame = 0;
                            if (escalateToReload) {
                                playerBufferState.fixAttempts = 0;
                                playerBufferState.recoveryReloadUsed = true;
                            }
                        }
                    } else {
                        resetStallRecovery();
                    }
                    // Detect position jump (native gap recovery) — drift to catch up.
                    // Skip during ad breaks and 10s after: backup stream switching causes buffer gaps that trigger false jumps.
                    // Rate-limit to once per 30s: field-observed on warn that Twitch's player.core.state.position
                    // jumps ~60s every ~12s on reload-heavy channels (likely batch updates from m3u8 manifest
                    // refreshes / program-date-time sync points, not real drift). Our 1.1x videoElement.playbackRate
                    // doesn't affect state.position anyway, so re-firing every 12s is useless log spam — the catch-up
                    // operates on currentTime which is already at live edge. Rate-limit collapses the spam to a
                    // single drift attempt per 30s window, leaving real-drift paths (buffer-gap seek, post-reload)
                    // unaffected since they call startDriftCorrection() directly without going through this detector.
                    if (
                        playerBufferState.position > 0 &&
                        position - playerBufferState.position > 5 &&
                        !playerBufferState.inAdBreak &&
                        !within(playerBufferState.lastBackupSwitchAt, BACKUP_SWITCH_GRACE_MS) &&
                        (!playerBufferState.lastDriftStartedAt ||
                            Date.now() - playerBufferState.lastDriftStartedAt >= 30000)
                    ) {
                        console.log(
                            '[AD DEBUG] Position jumped ' +
                                (position - playerBufferState.position).toFixed(1) +
                                's — starting drift correction',
                        );
                        const jumpVideo = player.getHTMLVideoElement?.();
                        if (jumpVideo) startDriftCorrection(jumpVideo);
                        playerBufferState.lastDriftStartedAt = Date.now();
                    }
                    playerBufferState.position = position;
                    playerBufferState.videoCurrentTime = videoCurrentTime;
                    playerBufferState.bufferedPosition = bufferedPosition;
                    playerBufferState.bufferDuration = bufferDuration;
                } else {
                    playerBufferState.numSame = 0;
                }
            }
        } catch (err) {
            console.error('error when monitoring player for buffering: ' + err);
            runtime.playerForMonitoringBuffering = null;
        }
    }
    // Post-break video-wedge recovery (mirrors GosuDRM/TTV-AB _checkPostBreakWedge, v12.0.0):
    // the "frozen video with running audio after an ad break" case (often after switching tabs and
    // coming back). The playhead keeps ADVANCING (audio clock alive) but the decoder stops emitting
    // frames — so a currentTime-based freeze check is structurally blind to it. Detect it directly by
    // decoded-frame count: arm a watch on the ad→no-ad edge, then flag ticks where currentTime advanced
    // but getVideoPlaybackQuality().totalVideoFrames did not. Escalate pause/play, then hard reload.
    // twitchAdSolutions_disablePostBreakWedge=true to disable.
    {
        const wedgeInAd = !!playerBufferState.inAdBreak;
        // Arm on the break-end edge (was in ad, now not) — start a bounded ~40-tick watch window.
        if (playerBufferState.wedgePrevInAdBreak && !wedgeInAd) {
            playerBufferState.wedgeEvalsRemaining = 40;
            playerBufferState.wedgeLastTime = -1;
            playerBufferState.wedgeLastFrames = -1;
            playerBufferState.wedgeEvidence = 0;
            playerBufferState.wedgeHealthy = 0;
            playerBufferState.wedgeActions = 0;
        }
        playerBufferState.wedgePrevInAdBreak = wedgeInAd;
        if (
            !state.DisablePostBreakWedge &&
            !wedgeInAd &&
            (playerBufferState.wedgeEvalsRemaining || 0) > 0 &&
            !playerBufferState.userPauseIntent &&
            runtime.playerForMonitoringBuffering &&
            runtime.playerForMonitoringBuffering.state?.props?.content?.type === 'live'
        ) {
            try {
                const wv = runtime.playerForMonitoringBuffering.player?.getHTMLVideoElement?.();
                // Only evaluable when the element is actively presenting: playing, has a video track,
                // decoded metadata, and exposes the playback-quality API. Otherwise wait (don't burn budget).
                if (
                    wv &&
                    !wv.ended &&
                    !wv.paused &&
                    wv.videoWidth > 0 &&
                    (wv.readyState ?? 0) >= 2 &&
                    typeof wv.getVideoPlaybackQuality === 'function'
                ) {
                    let totalFrames = -1;
                    try {
                        totalFrames = Number(wv.getVideoPlaybackQuality()?.totalVideoFrames);
                    } catch {}
                    if (Number.isFinite(totalFrames) && totalFrames >= 0) {
                        const t = wv.currentTime || 0;
                        // -1 = no baseline yet (same as unset: both fail the >= 0 checks below)
                        const prevT = playerBufferState.wedgeLastTime ?? -1;
                        const prevF = playerBufferState.wedgeLastFrames ?? -1;
                        playerBufferState.wedgeLastTime = t;
                        playerBufferState.wedgeLastFrames = totalFrames;
                        // Need a baseline AND real playhead advance (a frozen playhead is a different case —
                        // here we specifically want time-moving-but-frames-flat).
                        if (prevT >= 0 && prevF >= 0 && t > prevT + 0.3) {
                            playerBufferState.wedgeEvalsRemaining = (playerBufferState.wedgeEvalsRemaining || 0) - 1;
                            const framesDelta = totalFrames - prevF;
                            if (framesDelta < 0) {
                                // Frame counter went backwards → media element was re-instantiated (a
                                // reload). Rebaselined above; don't count this boundary as evidence.
                                playerBufferState.wedgeEvidence = 0;
                                playerBufferState.wedgeHealthy = 0;
                            } else if (framesDelta >= 5) {
                                // Decoder healthy — producing frames. Disarm after a few healthy ticks.
                                playerBufferState.wedgeEvidence = 0;
                                playerBufferState.wedgeHealthy = (playerBufferState.wedgeHealthy || 0) + 1;
                                if (playerBufferState.wedgeHealthy >= 3) playerBufferState.wedgeEvalsRemaining = 0;
                            } else if (framesDelta <= 1) {
                                // Wedge evidence — playhead advanced but ~no new frames.
                                playerBufferState.wedgeHealthy = 0;
                                playerBufferState.wedgeEvidence = (playerBufferState.wedgeEvidence || 0) + 1;
                                if (playerBufferState.wedgeEvidence >= 6) {
                                    playerBufferState.wedgeEvidence = 0;
                                    playerBufferState.wedgeActions = (playerBufferState.wedgeActions || 0) + 1;
                                    const wedgeReload = playerBufferState.wedgeActions >= 2; // nudge first, reload if it recurs
                                    const recentReload = within(playerBufferState.lastReloadAt, RELOAD_GRACE_MS);
                                    console.log(
                                        '[AD DEBUG] Post-break video wedge — playhead advancing at ' +
                                            t.toFixed(1) +
                                            's but only ' +
                                            Math.max(0, framesDelta) +
                                            ' decoded frame(s) over ' +
                                            (t - prevT).toFixed(1) +
                                            's (audio-alive/video-frozen after break) — ' +
                                            (wedgeReload ? 'hard reload' : 'pause/play nudge') +
                                            ' (mirrors TTV-AB v12.0.0)',
                                    );
                                    if (wedgeReload) {
                                        playerBufferState.wedgeEvalsRemaining = 0;
                                        if (!recentReload) {
                                            doTwitchPlayerTask('reload', 'early');
                                        } else {
                                            console.log(
                                                '[AD DEBUG] Post-break wedge reload SUPPRESSED — a reload fired <15s ago; relying on it',
                                            );
                                        }
                                    } else {
                                        doTwitchPlayerTask('pausePlay');
                                    }
                                    playerBufferState.lastFixTime = Date.now();
                                }
                            } else {
                                // Ambiguous (2-4 frames): neither clearly healthy nor wedged — reset the
                                // healthy streak but keep any accumulated evidence (matches TTV-AB).
                                playerBufferState.wedgeHealthy = 0;
                            }
                        }
                    }
                }
            } catch {}
        }
    }
    // Loading-circle health check: during an ad strip+recovery loop the normal buffer monitor
    // is gated off (isActivelyStrippingAds), so a visibly stalled player would otherwise wait
    // for the worker's poll-based early reload (~10s). This catches the visible stall ~3s after
    // it starts and triggers a reload directly, eliminating most of the loading-circle window.
    if (runtime.isActivelyStrippingAds && runtime.playerForMonitoringBuffering) {
        try {
            const player = runtime.playerForMonitoringBuffering.player;
            const video = player?.getHTMLVideoElement?.();
            if (video && !video.ended && !playerBufferState.userPauseIntent) {
                // Track whether the player has ever had data — distinguishes a real stall
                // (had data, lost data) from initial player init (never had data yet).
                // Without this, fresh page load + preroll causes PR #96 to misfire repeatedly
                // because readyState=0 is normal during init.
                if (video.readyState >= 3) {
                    playerBufferState.hasHadData = true;
                }
                const isStalled = video.readyState < 3 && (video.paused || video.networkState === 2);
                const stallReloadCooldown = 15000;
                const cooldownExpired =
                    !playerBufferState.lastAdStallReloadAt ||
                    Date.now() - playerBufferState.lastAdStallReloadAt > stallReloadCooldown;
                // Don't fire loading-circle reload if ANY reload happened recently — readyState=0
                // is the expected transient state during a reload's MediaSource teardown. Without
                // this, an early-reload in flight can trigger a redundant loading-circle reload.
                const recentReload = within(playerBufferState.lastReloadAt, stallReloadCooldown);
                if (isStalled && cooldownExpired && !recentReload && playerBufferState.hasHadData) {
                    if (!playerBufferState.adStallStartAt) {
                        playerBufferState.adStallStartAt = Date.now();
                    } else if (Date.now() - playerBufferState.adStallStartAt > 3000) {
                        console.log(
                            '[AD DEBUG] Loading circle detected during ad break (' +
                                ((Date.now() - playerBufferState.adStallStartAt) / 1000).toFixed(1) +
                                's stall, readyState=' +
                                video.readyState +
                                ') — early reload',
                        );
                        playerBufferState.lastAdStallReloadAt = Date.now();
                        playerBufferState.adStallStartAt = 0;
                        // Hard reload: a stuck media player needs its MediaSource rebuilt, not just an m3u8 refetch.
                        doTwitchPlayerTask('reload', 'early');
                    }
                } else if (!isStalled) {
                    playerBufferState.adStallStartAt = 0;
                }
            }
        } catch {}
    } else if (!runtime.isActivelyStrippingAds && playerBufferState.adStallStartAt) {
        playerBufferState.adStallStartAt = 0;
    }
    const isLive = runtime.playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
    if (playerBufferState.isLive && !isLive) {
        updateAdblockBanner({
            hasAds: false,
        });
    }
    playerBufferState.isLive = isLive;
    // Force immediate tick when tab becomes visible so stalls are caught fast on return
    if (typeof document !== 'undefined' && !visibilityHooked) {
        visibilityHooked = true;
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && !pendingTick) {
                pendingTick = true;
                setTimeout(() => {
                    pendingTick = false;
                    monitorPlayerBuffering();
                }, 100);
            }
        });
    }
    // Catch persistent ad-break overlays (e.g. "taking an ad break / stick around")
    // even after hasAds has transitioned to false. updateAdblockBanner only calls
    // hideTwitchAdOverlays during the active ad break; some overlays have their own
    // lifecycle and stay visible afterwards. Running here on every monitor tick
    // (1-3s cadence) keeps them hidden without a dedicated interval.
    try {
        hideTwitchAdOverlays();
    } catch {}
    // Visibility-aware backoff: poll 3x slower when tab is hidden (but NOT during PiP — user is still watching).
    // Exception: don't back off during an active ad break — hidden-tab recovery (backup search → reload) is
    // already slowed by browser timer clamping; the 3x backoff compounds the "stuck loading until refocus"
    // stall some users hit when a break starts on a backgrounded tab (issue #129). Workaround, not a full fix:
    // background media deprioritization is browser-level. Negligible cost — only polls faster while hidden + in-break.
    const shouldThrottle =
        typeof document !== 'undefined' &&
        document.hidden &&
        !document.pictureInPictureElement &&
        !playerBufferState.inAdBreak;
    const nextDelay = shouldThrottle ? state.PlayerBufferingDelay * 3 : state.PlayerBufferingDelay;
    setTimeout(monitorPlayerBuffering, nextDelay);
}
