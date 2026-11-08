import { getPlayerAndState } from './twitch.ts';
import { playerBufferState, runtime, state } from './state.ts';
import { startDriftCorrection } from './drift.ts';
import { doTwitchPlayerTask } from './player.ts';
import { hideTwitchAdOverlays, updateAdblockBanner } from './overlay.ts';
import { resetStallLadder, type StallObservation, stallTick } from './stall.ts';
import { armWedgeWatch, wedgeSample } from './wedge.ts';
import type { TwitchMediaPlayer, TwitchPlayerState } from './twitch.ts';

const RELOAD_GRACE_MS = 15000;
const BACKUP_SWITCH_GRACE_MS = 10000;
const SCRIPT_PAUSE_ECHO_MS = 2000;
const AD_STALL_RELOAD_AFTER_MS = 3000;
const AD_STALL_COOLDOWN_MS = 15000;
function within(at: number, ms: number): boolean {
    return !!at && Date.now() - at < ms;
}
let pendingTick = false;
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
function monitorPlayerBuffering() {
    // Twitch can restart its player, so look it up every tick.
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
                    if (!within(playerBufferState.scriptPausedAt, SCRIPT_PAUSE_ECHO_MS)) {
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
        runtime.isActivelyStrippingAds = false;
        updateAdblockBanner({
            hasAds: false,
        });
    }
    playerBufferState.isLive = isLive;
    // Twitch's ad overlays can outlive the break, so hide them on every tick, not only during one.
    try {
        hideTwitchAdOverlays();
    } catch {}
    // Hidden tabs poll 3x slower, except in PiP and during a break: browsers already clamp
    // background-tab timers, and slowing further left breaks stuck loading until refocus (issue #129).
    const shouldThrottle =
        typeof document !== 'undefined' &&
        document.hidden &&
        !document.pictureInPictureElement &&
        !playerBufferState.inAdBreak;
    const nextDelay = shouldThrottle ? state.PlayerBufferingDelay * 3 : state.PlayerBufferingDelay;
    setTimeout(monitorPlayerBuffering, nextDelay);
}

function onChannelChange(channelName: string) {
    playerBufferState.channelName = channelName;
    playerBufferState.hasStreamStarted = false;
    resetStallLadder(playerBufferState.stall);
    playerBufferState.userPauseIntent = false;
    playerBufferState.loggedPauseIntent = false;
    playerBufferState.hasHadData = false;
    playerBufferState.adStall = { phase: 'idle' };
}

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
    // Twitch's core.state.position updates in batches on reload-heavy channels (PR #183) and can
    // look frozen for ~12s while currentTime advances; a stall needs both frozen.
    const videoCurrentTime = video.currentTime;
    if (position === undefined || bufferedPosition === undefined) {
        playerBufferState.stall.frozenTicks = 0;
        return;
    }
    // FFZ's audio compressor replaces the <video> on every player.load() (FFZ
    // src/sites/shared/player.jsx replaceVideoElement), and Twitch's playback monitor snaps the new
    // element to "buffered region 0.04…" while its buffer rebuilds: start a new recovery window.
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
    // Twitch's core.state.position can jump ~60s every ~12s on reload-heavy channels without real
    // drift, and playbackRate doesn't move it: at most one catch-up per 30s.
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

function observeStall(
    video: HTMLVideoElement,
    position: number,
    bufferedPosition: number,
    bufferDuration: number,
    videoCurrentTime: number | undefined,
): StallObservation {
    // Hold while the element isn't trying to play. Below HAVE_CURRENT_DATA (MSE init, seek, fresh
    // load) currentTime and position are 0 without a stall. player.isPaused() and video.paused can
    // disagree briefly during reload teardown and autoplay-policy mute toggles.
    if (video.readyState < 2 || video.paused) {
        return 'hold';
    }
    const positionFrozen =
        playerBufferState.position === position &&
        (playerBufferState.videoCurrentTime === undefined || playerBufferState.videoCurrentTime === videoCurrentTime);
    const stalled =
        playerBufferState.hasStreamStarted &&
        // AND, not OR: on Firefox at the live edge the buffer breathes at ~1-2s while currentTime
        // waits on a segment, and a pause/play there knocks the player back to readyState 1,
        // currentTime 0.
        positionFrozen &&
        bufferDuration < state.PlayerBufferingDangerZone &&
        playerBufferState.bufferedPosition === bufferedPosition &&
        playerBufferState.bufferDuration >= bufferDuration &&
        (position !== 0 || bufferedPosition !== 0 || bufferDuration !== 0);
    return stalled ? 'frozen' : 'healthy';
}

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
        // readyState is 0 during the player's initial load (PR #96).
        if (video.readyState >= 3) {
            playerBufferState.hasHadData = true;
        }
        const isStalled = video.readyState < 3 && (video.paused || video.networkState === 2);
        if (!isStalled) {
            playerBufferState.adStall = { phase: 'idle' };
            return;
        }
        // readyState 0 is expected during a reload's MediaSource teardown.
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
