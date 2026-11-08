import { getPlayerAndState } from './twitch.ts';
import { playerBufferState, runtime, state } from './state.ts';
import { startDriftCorrection } from './drift.ts';
import { doTwitchPlayerTask } from './player.ts';
import { hideTwitchAdOverlays, updateAdblockBanner } from './overlay.ts';
import { resetStallLadder, type StallObservation, stallTick } from './stall.ts';
import { armWedgeWatch, wedgeSample } from './wedge.ts';
import type { TwitchMediaPlayer, TwitchPlayerState } from './twitch.ts';

// Grace windows after a player reload and after a backup stream switch (start or end of an ad
// break): the stall fixes stand down while the player settles.
const RELOAD_GRACE_MS = 15000;
const BACKUP_SWITCH_GRACE_MS = 10000;
/** A pause event this soon after our own pause/play or reload is ours, not the user's. */
const SCRIPT_PAUSE_ECHO_MS = 2000;
/** Loading-circle detector: stall length before reloading, and cooldown between its reloads. */
const AD_STALL_RELOAD_AFTER_MS = 3000;
const AD_STALL_COOLDOWN_MS = 15000;
/** Whether timestamp `at` is set and less than `ms` ago. */
function within(at: number, ms: number): boolean {
    return !!at && Date.now() - at < ms;
}
/** A tick scheduled by the visibility listener is pending (dedupes repeated events). */
let pendingTick = false;
/** Run the first monitor tick, then tick right away whenever the tab becomes visible again. */
export function startBufferMonitor() {
    monitorPlayerBuffering();
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
// Poll the player state to detect and fix buffering caused by ad stream switching
function monitorPlayerBuffering() {
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
                    if (!within(playerBufferState.weJustPaused, SCRIPT_PAUSE_ECHO_MS)) {
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
            const { player, state: twitchState } = runtime.playerForMonitoringBuffering;
            if (!player.core) {
                runtime.playerForMonitoringBuffering = null;
            } else {
                checkStall(player, twitchState);
            }
        } catch (err) {
            console.error('error when monitoring player for buffering: ' + err);
            runtime.playerForMonitoringBuffering = null;
        }
    }
    checkPostBreakWedge();
    checkAdStall();
    const isLive = runtime.playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
    if (playerBufferState.isLive && !isLive) {
        // Left live content: nothing is being stripped for this player any more.
        runtime.isActivelyStrippingAds = false;
        updateAdblockBanner({
            hasAds: false,
        });
    }
    playerBufferState.isLive = isLive;
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

// A new channel: everything the monitor learned about the previous one is void.
function onChannelChange(channelName: string) {
    playerBufferState.channelName = channelName;
    playerBufferState.hasStreamStarted = false;
    resetStallLadder(playerBufferState.stall);
    playerBufferState.userPauseIntent = false;
    playerBufferState.loggedPauseIntent = false;
    playerBufferState.hasHadData = false;
    playerBufferState.adStall = { phase: 'idle' };
}

// Stall ladder (src/page/stall.ts) and position-jump drift detection. Stands down outside live
// playback, during ad handling and in the grace windows after reloads and backup switches.
function checkStall(player: TwitchMediaPlayer, twitchState: TwitchPlayerState) {
    if (twitchState.props?.content?.type !== 'live' || player.isPaused()) {
        return;
    }
    const video = player.getHTMLVideoElement();
    if (
        !video ||
        video.ended ||
        (video.readyState ?? 0) < 1 ||
        playerBufferState.lastFixTime > Date.now() - state.PlayerBufferingMinRepeatDelay ||
        runtime.isActivelyStrippingAds ||
        playerBufferState.inAdBreak ||
        within(playerBufferState.lastReloadAt, RELOAD_GRACE_MS) ||
        within(playerBufferState.lastBackupSwitchAt, BACKUP_SWITCH_GRACE_MS)
    ) {
        return;
    }
    const m3u8Url = player.core?.state?.path;
    if (m3u8Url) {
        const lastSlash = m3u8Url.lastIndexOf('/');
        const queryStart = m3u8Url.indexOf('?', lastSlash);
        const fileName = m3u8Url.substring(lastSlash + 1, queryStart !== -1 ? queryStart : undefined);
        if (fileName?.endsWith('.m3u8')) {
            const channelName = fileName.slice(0, -5);
            if (playerBufferState.channelName !== channelName) {
                onChannelChange(channelName);
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
    const videoCurrentTime = video.currentTime;
    if (position === undefined || bufferedPosition === undefined) {
        playerBufferState.stall.frozenTicks = 0;
        return;
    }
    // NOTE: This could be improved. It currently lets the player fully eat the full buffer before it triggers pause/play
    // FFZ's audio compressor wraps player.load() and creates a fresh <video>
    // element on every load (src/sites/shared/player.jsx replaceVideoElement).
    // Twitch's playback-monitor then snaps the new element to "buffered region
    // 0.04xxx" while the buffer rebuilds. During that brief ramp-up window,
    // currentTime plateaus and state.position is also at its post-reload reset
    // — exactly the positionFrozen pattern. Detect the swap by element identity
    // and treat it like a fresh reload (start a new recovery window).
    if (playerBufferState.videoElement && playerBufferState.videoElement !== video) {
        resetStallLadder(playerBufferState.stall);
    }
    playerBufferState.videoElement = video;
    const step = stallTick(
        playerBufferState.stall,
        observeStall(video, position, bufferedPosition, bufferDuration, videoCurrentTime),
        state.PlayerBufferingSameStateCount,
        !state.DisableReloadCap,
    );
    if (step.action !== 'none') {
        const note = step.capped
            ? ' (reload cap reached, pause/play only — set twitchAdSolutions_disableReloadCap=true to bypass)'
            : step.action === 'reload'
              ? ' (escalating to reload)'
              : '';
        console.log(
            'Attempt to fix buffering position:' +
                playerBufferState.position +
                ' bufferedPosition:' +
                playerBufferState.bufferedPosition +
                ' bufferDuration:' +
                playerBufferState.bufferDuration +
                note,
        );
        // Seek past buffer gap instead of stalling + drift to recover
        if (video.buffered.length > 1) {
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
        console.log(
            '[AD DEBUG] Video state: readyState=' +
                video.readyState +
                ' networkState=' +
                video.networkState +
                ' buffered=' +
                (video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1).toFixed(1) : 0) +
                ' currentTime=' +
                video.currentTime.toFixed(1) +
                ' paused=' +
                video.paused,
        );
        doTwitchPlayerTask(step.action === 'reload' ? 'reload' : 'pausePlay');
        playerBufferState.lastFixTime = Date.now();
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
        (!playerBufferState.lastDriftStartedAt || Date.now() - playerBufferState.lastDriftStartedAt >= 30000)
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
}

// Classify this tick for the stall ladder against the previous tick's snapshot.
function observeStall(
    video: HTMLVideoElement,
    position: number,
    bufferedPosition: number,
    bufferDuration: number,
    videoCurrentTime: number | undefined,
): StallObservation {
    // Hold while the <video> element isn't actively trying to play:
    //   readyState < 2 (HAVE_CURRENT_DATA) — MSE init / seek in flight / fresh post-
    //     reload load. currentTime and state.position are both genuinely 0 here, but
    //     it's an initialization state, not a stall — escalating would loop reloads.
    //   video.paused === true — player.isPaused() and the underlying <video>.paused can
    //     disagree briefly during reload teardown / autoplay-policy mute toggles.
    if (video.readyState < 2 || video.paused) {
        return 'hold';
    }
    // Position-frozen requires BOTH state.position AND video.currentTime unchanged: if
    // currentTime is advancing the player is playing fine (the false-fires were causing
    // user-visible 8s-cadence abrupts on low-latency / post-quality-change states).
    const positionFrozen =
        playerBufferState.position === position &&
        (playerBufferState.videoCurrentTime === undefined || playerBufferState.videoCurrentTime === videoCurrentTime);
    const stalled =
        playerBufferState.hasStreamStarted &&
        // AND, not OR: a real stall is BOTH frozen position AND a draining buffer. Field reports
        // on Firefox at live edge showed the OR form firing during normal thin-buffer breathing
        // (~1-2s buffered, currentTime briefly idle waiting on a segment fetch) — pause/play
        // would then knock the player back to readyState=1 and currentTime=0, snowballing into
        // a self-reinforcing reload cascade.
        positionFrozen &&
        bufferDuration < state.PlayerBufferingDangerZone &&
        playerBufferState.bufferedPosition === bufferedPosition &&
        playerBufferState.bufferDuration >= bufferDuration &&
        (position !== 0 || bufferedPosition !== 0 || bufferDuration !== 0);
    return stalled ? 'frozen' : 'healthy';
}

// Post-break video-wedge watch (src/page/wedge.ts): armed on the ad→no-ad edge, sampled while the
// element is actively presenting. twitchAdSolutions_disablePostBreakWedge=true disables it.
function checkPostBreakWedge() {
    const inAd = playerBufferState.inAdBreak;
    if (playerBufferState.wedgeWasInAdBreak && !inAd) {
        playerBufferState.wedge = armWedgeWatch();
    }
    playerBufferState.wedgeWasInAdBreak = inAd;
    const monitored = runtime.playerForMonitoringBuffering;
    if (
        state.DisablePostBreakWedge ||
        inAd ||
        playerBufferState.wedge.phase !== 'watching' ||
        playerBufferState.userPauseIntent ||
        !monitored ||
        monitored.state?.props?.content?.type !== 'live'
    ) {
        return;
    }
    try {
        const wv = monitored.player?.getHTMLVideoElement?.();
        // Only evaluable when the element is actively presenting: playing, has a video track,
        // decoded metadata, and exposes the playback-quality API. Otherwise wait (don't burn budget).
        if (
            !wv ||
            wv.ended ||
            wv.paused ||
            !(wv.videoWidth > 0) ||
            (wv.readyState ?? 0) < 2 ||
            typeof wv.getVideoPlaybackQuality !== 'function'
        ) {
            return;
        }
        let totalFrames = -1;
        try {
            totalFrames = Number(wv.getVideoPlaybackQuality()?.totalVideoFrames);
        } catch {}
        if (!Number.isFinite(totalFrames) || totalFrames < 0) {
            return;
        }
        const { next, step } = wedgeSample(playerBufferState.wedge, wv.currentTime || 0, totalFrames);
        playerBufferState.wedge = next;
        if (step.action === 'none') {
            return;
        }
        console.log(
            '[AD DEBUG] Post-break video wedge — playhead advancing at ' +
                step.time.toFixed(1) +
                's but only ' +
                Math.max(0, step.framesDelta) +
                ' decoded frame(s) over ' +
                step.elapsed.toFixed(1) +
                's (audio-alive/video-frozen after break) — ' +
                (step.action === 'reload' ? 'hard reload' : 'pause/play nudge') +
                ' (mirrors TTV-AB v12.0.0)',
        );
        if (step.action === 'nudge') {
            doTwitchPlayerTask('pausePlay');
        } else if (within(playerBufferState.lastReloadAt, RELOAD_GRACE_MS)) {
            console.log('[AD DEBUG] Post-break wedge reload SUPPRESSED — a reload fired <15s ago; relying on it');
        } else {
            doTwitchPlayerTask('reload', 'early');
        }
        playerBufferState.lastFixTime = Date.now();
    } catch {}
}

// Loading-circle detector (AdStallState): during an ad strip+recovery loop the normal stall
// ladder is gated off (isActivelyStrippingAds), so a visibly stalled player would otherwise wait
// for the worker's poll-based early reload (~10s). This catches the visible stall ~3s after it
// starts and reloads directly, eliminating most of the loading-circle window.
function checkAdStall() {
    if (!runtime.isActivelyStrippingAds) {
        playerBufferState.adStall = { phase: 'idle' };
        return;
    }
    if (!runtime.playerForMonitoringBuffering) {
        return;
    }
    try {
        const video = runtime.playerForMonitoringBuffering.player?.getHTMLVideoElement?.();
        if (!video || video.ended || playerBufferState.userPauseIntent) {
            return;
        }
        // Whether the player has had data on this channel — distinguishes a real stall (had
        // data, lost data) from initial player init (readyState=0 is normal then; without this,
        // fresh page load + preroll misfires repeatedly, PR #96).
        if (video.readyState >= 3) {
            playerBufferState.hasHadData = true;
        }
        const isStalled = video.readyState < 3 && (video.paused || video.networkState === 2);
        if (!isStalled) {
            playerBufferState.adStall = { phase: 'idle' };
            return;
        }
        // Not while any reload is recent — readyState=0 is the expected transient state during a
        // reload's MediaSource teardown, and an early reload may be in flight.
        if (
            within(playerBufferState.lastAdStallReloadAt, AD_STALL_COOLDOWN_MS) ||
            within(playerBufferState.lastReloadAt, AD_STALL_COOLDOWN_MS) ||
            !playerBufferState.hasHadData
        ) {
            return;
        }
        const stall = playerBufferState.adStall;
        if (stall.phase === 'idle') {
            playerBufferState.adStall = { phase: 'stalling', since: Date.now() };
        } else if (Date.now() - stall.since > AD_STALL_RELOAD_AFTER_MS) {
            console.log(
                '[AD DEBUG] Loading circle detected during ad break (' +
                    ((Date.now() - stall.since) / 1000).toFixed(1) +
                    's stall, readyState=' +
                    video.readyState +
                    ') — early reload',
            );
            playerBufferState.lastAdStallReloadAt = Date.now();
            playerBufferState.adStall = { phase: 'idle' };
            // Hard reload: a stuck media player needs its MediaSource rebuilt, not just an m3u8 refetch.
            doTwitchPlayerTask('reload', 'early');
        }
    } catch {}
}
