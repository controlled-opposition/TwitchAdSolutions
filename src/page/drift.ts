import { getPlayerVideoElement } from './twitch.ts';
import { state } from './state.ts';

const CHECK_INTERVAL_MS = 500;
const SAFETY_TIMEOUT_MS = 30000;
const CAUGHT_UP_S = 1;

interface Catchup {
    element: HTMLVideoElement;
    interval: ReturnType<typeof setInterval>;
    timeout: ReturnType<typeof setTimeout>;
}
let catchup: Catchup | null = null;

export function cancelDriftCorrection() {
    if (!catchup) return;
    const { element, interval, timeout } = catchup;
    catchup = null;
    clearInterval(interval);
    clearTimeout(timeout);
    try {
        element.playbackRate = 1.0;
    } catch {}
    try {
        const current = getPlayerVideoElement();
        if (current && current !== element && current.playbackRate === state.DriftCorrectionRate) {
            current.playbackRate = 1.0;
        }
    } catch {}
}

export function startDriftCorrection(videoElement: HTMLVideoElement) {
    if (state.DriftCorrectionRate <= 1) return;
    cancelDriftCorrection();
    videoElement.playbackRate = state.DriftCorrectionRate;
    console.log('[AD DEBUG] Drift correction: catching up at ' + state.DriftCorrectionRate + 'x');
    const interval = setInterval(() => {
        try {
            const vid = getPlayerVideoElement();
            if (vid && vid.buffered.length > 0) {
                if (vid.buffered.end(vid.buffered.length - 1) - vid.currentTime <= CAUGHT_UP_S) {
                    console.log('[AD DEBUG] Drift correction complete — resumed normal playback speed');
                    cancelDriftCorrection();
                }
            }
        } catch {
            cancelDriftCorrection();
        }
    }, CHECK_INTERVAL_MS);
    const timeout = setTimeout(cancelDriftCorrection, SAFETY_TIMEOUT_MS);
    catchup = { element: videoElement, interval, timeout };
}
