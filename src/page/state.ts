import { defaultSharedConfig } from '../shared/config.ts';
import { createStallLadder, type StallLadder } from './stall.ts';
import type { TwitchMediaPlayer, TwitchPlayerState } from './twitch.ts';
import type { WedgeWatch } from './wedge.ts';

function createPageState() {
    return {
        ...defaultSharedConfig(),
        RecoverFromSilentMute: true,
        DisablePostBreakWedge: false,
        DisableReloadCap: false,
        DriftCorrectionRate: 1.1,
        PlayerBufferingDelay: 600,
        PlayerBufferingSameStateCount: 3,
        // Above ~0.5s a pause/play fix makes Twitch's playback monitor snap to "buffered region
        // 0.04…", and each fix degrades currentTime further.
        PlayerBufferingDangerZone: 0.5,
        PlayerBufferingMinRepeatDelay: 8000,
    };
}

export const state = createPageState();

export const runtime = {
    isActivelyStrippingAds: false,
    localStorageHookFailed: false,
    playerForMonitoringBuffering: null as { player: TwitchMediaPlayer; state: TwitchPlayerState } | null,
};

export type AdStallState = { phase: 'idle' } | { phase: 'stalling'; since: number };

interface PlayerBufferState {
    channelName: string | null;
    hasStreamStarted: boolean;
    position: number;
    bufferedPosition: number;
    bufferDuration: number;
    stall: StallLadder;
    lastFixTime: number;
    isLive: boolean;
    lastBackupSwitchAt: number;
    lastReloadAt: number;
    userPauseIntent: boolean;
    loggedPauseIntent: boolean;
    scriptPausedAt: number;
    inAdBreak: boolean;
    vaftEverUnmuted: boolean;
    videoElement?: HTMLVideoElement | null;
    videoCurrentTime?: number;
    lastDriftStartedAt?: number;
    hasHadData: boolean;
    adStall: AdStallState;
    lastAdStallReloadAt: number;
    wedgeWasInAdBreak: boolean;
    wedge: WedgeWatch;
}

export const playerBufferState: PlayerBufferState = {
    channelName: null,
    hasStreamStarted: false,
    position: 0,
    bufferedPosition: 0,
    bufferDuration: 0,
    stall: createStallLadder(),
    lastFixTime: 0,
    isLive: true,
    lastBackupSwitchAt: 0,
    lastReloadAt: 0,
    userPauseIntent: false,
    loggedPauseIntent: false,
    scriptPausedAt: 0,
    inAdBreak: false,
    vaftEverUnmuted: false,
    hasHadData: false,
    adStall: { phase: 'idle' },
    lastAdStallReloadAt: 0,
    wedgeWasInAdBreak: false,
    wedge: { phase: 'disarmed' },
};
