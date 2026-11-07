// Page-side settings and state.
import { defaultSharedConfig } from '../shared/config.ts';
import type { TwitchMediaPlayer, TwitchPlayerState } from './twitch.ts';

function createPageState() {
    return {
        ...defaultSharedConfig(),
        RecoverFromSilentMute: true, // On hard reload, if the element is already muted but vaft has successfully unmuted at any point earlier this session, treat it as a silent Twitch re-mute and recover via the backstop. Default on; set twitchAdSolutions_recoverFromSilentMute=false to disable (useful for users who deliberately mute mid-session).
        DisablePostBreakWedge: false, // Post-break video-wedge recovery (mirrors GosuDRM/TTV-AB _checkPostBreakWedge, v12.0.0). Detects "audio running, video frozen" after an ad break — playhead advancing while the decoder emits no new frames — via getVideoPlaybackQuality().totalVideoFrames, which the currentTime-based freeze checks can't see. Default on. Set twitchAdSolutions_disablePostBreakWedge=true to turn it OFF.
        DisableReloadCap: false, // If true, buffer monitor reloads unlimited times (pre-v47 behavior, risk of cascade)
        DriftCorrectionRate: 1.1, // Playback rate for catching up to live edge after reload (0 = disable drift correction)
        PlayerBufferingFix: true, // If true this will pause/play the player when it gets stuck buffering
        PlayerBufferingDelay: 600, // How often should we check the player state (in milliseconds)
        PlayerBufferingSameStateCount: 3, // How many times of seeing the same player state until we trigger pause/play (it will only trigger it one time until the player state changes again)
        PlayerBufferingDangerZone: 0.5, // Lowered 1 → 0.5: at the live edge with thin-but-functional buffer (~0.7-0.95s), the AND check (positionFrozen + bufferDuration < DangerZone) was firing on real momentary stalls — but the pause/play "fix" interacts badly with Twitch's playback-monitor (snaps to "buffered region 0.04xxx"), creating a self-sustaining cascade where each fix degrades currentTime. Lower threshold confines firing to truly-drained buffer states (<0.5s) where intervention is unambiguously needed.
        PlayerBufferingDoPlayerReload: false, // If true this will do a player reload instead of pause/play (player reloading is better at fixing the playback issues but it takes slightly longer)
        PlayerBufferingMinRepeatDelay: 8000, // Minimum delay (in milliseconds) between each pause/play (this is to avoid over pressing pause/play when there are genuine buffering problems)
        PlayerBufferingPrerollCheckEnabled: false, // Enable this if you're getting an immediate pause/play/reload as you open a stream (which is causing the stream to take longer to load). One problem with this being true is that it can cause the player to get stuck in some instances requiring the user to press pause/play
        PlayerBufferingPrerollCheckOffset: 5, // How far the stream need to move before doing the buffering mitigation (depends on PlayerBufferingPrerollCheckEnabled being true)
    };
}

export const state = createPageState();

/** Page-side flags that more than one module reads and writes. */
export const runtime = {
    /** Set from the worker's banner updates; the buffer monitor stands down while true. */
    isActivelyStrippingAds: false,
    /** Firefox doesn't allow hooking localStorage; reloads then write the volume/mute keys directly. */
    localStorageHookFailed: false,
    /** Re-acquired on every monitor tick. */
    playerForMonitoringBuffering: null as { player: TwitchMediaPlayer; state: TwitchPlayerState } | null,
};

/** Buffer-monitor state shared by monitorPlayerBuffering(), doTwitchPlayerTask() and the worker message handler. */
export interface PlayerBufferState {
    channelName: string | null;
    hasStreamStarted: boolean;
    position: number;
    bufferedPosition: number;
    bufferDuration: number;
    numSame: number;
    fixAttempts: number;
    lastFixTime: number;
    isLive: boolean;
    lastBackupSwitchAt: number;
    lastReloadAt: number;
    recoveryReloadUsed: boolean;
    userPauseIntent: boolean;
    loggedPauseIntent: boolean;
    /** Time of our last pause/play or reload (ms); 0 when none is pending. */
    weJustPaused: number;
    inAdBreak: boolean;
    vaftEverUnmuted: boolean;
    // Set lazily by the monitor. Left unset on purpose: videoCurrentTime is checked with `=== undefined`.
    videoElement?: HTMLVideoElement | null;
    videoCurrentTime?: number;
    lastDriftStartedAt?: number;
    hasHadData?: boolean;
    adStallStartAt?: number;
    lastAdStallReloadAt?: number;
    // Post-break video-wedge watch
    wedgePrevInAdBreak?: boolean;
    wedgeEvalsRemaining?: number;
    wedgeLastTime?: number;
    wedgeLastFrames?: number;
    wedgeEvidence?: number;
    wedgeHealthy?: number;
    wedgeActions?: number;
}

export const playerBufferState: PlayerBufferState = {
    channelName: null,
    hasStreamStarted: false,
    position: 0,
    bufferedPosition: 0,
    bufferDuration: 0,
    numSame: 0,
    fixAttempts: 0,
    lastFixTime: 0,
    isLive: true,
    lastBackupSwitchAt: 0,
    lastReloadAt: 0,
    recoveryReloadUsed: false,
    userPauseIntent: false,
    loggedPauseIntent: false,
    weJustPaused: 0,
    inAdBreak: false,
    vaftEverUnmuted: false,
};
