// Drift correction: play faster than real time until the playhead is back near the live edge.
//
//     idle ──startDriftCorrection(el)──▶ catching up ──≤1s behind / 30s timeout / cancel──▶ idle
//
// Restarting while catching up starts fresh. The element whose rate was raised is tracked, so
// finishing always resets that element (a reload in between can put a different <video> first in
// the DOM), and the new player element too if it has picked up the raised rate.
import { getPlayerVideoElement } from './twitch.ts';
import { state } from './state.ts';

const CHECK_INTERVAL_MS = 500;
const SAFETY_TIMEOUT_MS = 30000;
/** Close enough to the buffered end to stop catching up (s). */
const CAUGHT_UP_S = 1;

interface Catchup {
    element: HTMLVideoElement;
    interval: ReturnType<typeof setInterval>;
    timeout: ReturnType<typeof setTimeout>;
}
let catchup: Catchup | null = null;

/** Back to idle: stop the timers and return the tracked element (and the current one) to 1×. */
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

/** Stop any drift catch-up in progress and return to normal speed (no-op when none is running). */
