import { getPlayerVideoElement } from './twitch.ts';
import { state } from './state.ts';

let driftCatchUpInterval: ReturnType<typeof setInterval> | null = null;
let driftCatchUpTimeout: ReturnType<typeof setTimeout> | null = null;
export function startDriftCorrection(videoElement: HTMLVideoElement) {
    if (state.DriftCorrectionRate <= 1) return;
    if (driftCatchUpInterval) {
        clearInterval(driftCatchUpInterval);
        driftCatchUpInterval = null;
    }
    if (driftCatchUpTimeout) {
        clearTimeout(driftCatchUpTimeout);
        driftCatchUpTimeout = null;
    }
    videoElement.playbackRate = state.DriftCorrectionRate;
    console.log('[AD DEBUG] Drift correction: catching up at ' + state.DriftCorrectionRate + 'x');
    driftCatchUpInterval = setInterval(() => {
        try {
            const vid = getPlayerVideoElement();
            if (vid && vid.buffered.length > 0) {
                if (vid.buffered.end(vid.buffered.length - 1) - vid.currentTime <= 1) {
                    vid.playbackRate = 1.0;
                    console.log('[AD DEBUG] Drift correction complete — resumed normal playback speed');
                    clearInterval(driftCatchUpInterval ?? undefined);
                    driftCatchUpInterval = null;
                    if (driftCatchUpTimeout) {
                        clearTimeout(driftCatchUpTimeout);
                        driftCatchUpTimeout = null;
                    }
                }
            }
        } catch {
            clearInterval(driftCatchUpInterval ?? undefined);
            driftCatchUpInterval = null;
        }
    }, 500);
    driftCatchUpTimeout = setTimeout(() => {
        try {
            videoElement.playbackRate = 1.0;
        } catch {}
        if (driftCatchUpInterval) {
            clearInterval(driftCatchUpInterval);
            driftCatchUpInterval = null;
        }
        driftCatchUpTimeout = null;
    }, 30000);
}
/** Stop any drift catch-up in progress and return to normal speed (no-op when none is running). */
export function cancelDriftCorrection() {
    // Clear drift catch-up when ads start — don't run 1.1x during ad handling
    if (driftCatchUpInterval || driftCatchUpTimeout) {
        if (driftCatchUpInterval) {
            clearInterval(driftCatchUpInterval);
            driftCatchUpInterval = null;
        }
        if (driftCatchUpTimeout) {
            clearTimeout(driftCatchUpTimeout);
            driftCatchUpTimeout = null;
        }
        try {
            const v = getPlayerVideoElement();
            if (v) v.playbackRate = 1.0;
        } catch {}
    }
}
