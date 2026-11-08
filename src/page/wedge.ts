// Post-break video-wedge watch (mirrors GosuDRM/TTV-AB _checkPostBreakWedge, v12.0.0): the
// "frozen video with running audio after an ad break" case. The playhead keeps advancing (audio
// clock alive) but the decoder stops emitting frames, which a currentTime-based freeze check
// can't see. Detected by decoded-frame count:
//
//     disarmed ──ad→no-ad edge──▶ watching (40 evaluations)
//                                   ├─ 3 healthy evaluations in a row ──▶ disarmed
//                                   ├─ 6 wedged evaluations: 1st time pause/play, 2nd time reload ──▶ disarmed
//                                   └─ evaluations used up ─────────────▶ disarmed
//
// An evaluation is a tick where the playhead advanced >0.3s: ≥5 new frames is healthy, ≤1 is
// wedge evidence, 2-4 is ambiguous (breaks a healthy streak, keeps evidence).

export type WedgeWatch =
    | { phase: 'disarmed' }
    | {
          phase: 'watching';
          evalsLeft: number;
          /** Baseline from the previous sample (null until the first one). */
          last: { time: number; frames: number } | null;
          evidence: number;
          healthy: number;
          /** Fixes made in this watch; the second one reloads. */
          actions: number;
      };

type WedgeStep =
    | { action: 'none' }
    | { action: 'nudge' | 'reload'; time: number; elapsed: number; framesDelta: number };

const WATCH_EVALS = 40;
const MIN_ADVANCE_S = 0.3;
const HEALTHY_FRAMES = 5;
const WEDGED_MAX_FRAMES = 1;
const HEALTHY_TO_DISARM = 3;
const EVIDENCE_TO_ACT = 6;

export function armWedgeWatch(): WedgeWatch {
    return { phase: 'watching', evalsLeft: WATCH_EVALS, last: null, evidence: 0, healthy: 0, actions: 0 };
}

/**
 * Feed one sample (currentTime, totalVideoFrames) taken while the element is actively presenting.
 * Returns the watch's next state and what to do now.
 */
export function wedgeSample(watch: WedgeWatch, time: number, frames: number): { next: WedgeWatch; step: WedgeStep } {
    if (watch.phase !== 'watching') return { next: watch, step: { action: 'none' } };
    const prev = watch.last;
    const w = { ...watch, last: { time, frames } };
    // Need a baseline AND real playhead advance (a frozen playhead is a different case — here
    // we specifically want time-moving-but-frames-flat).
    if (!prev || time <= prev.time + MIN_ADVANCE_S) {
        return { next: w, step: { action: 'none' } };
    }
    w.evalsLeft--;
    const framesDelta = frames - prev.frames;
    let step: WedgeStep = { action: 'none' };
    if (framesDelta < 0) {
        // Frame counter went backwards: the media element was re-instantiated (a reload).
        // Rebaselined above; this boundary isn't evidence.
        w.evidence = 0;
        w.healthy = 0;
    } else if (framesDelta >= HEALTHY_FRAMES) {
        w.evidence = 0;
        w.healthy++;
        if (w.healthy >= HEALTHY_TO_DISARM) return { next: { phase: 'disarmed' }, step };
    } else if (framesDelta <= WEDGED_MAX_FRAMES) {
        w.healthy = 0;
        w.evidence++;
        if (w.evidence >= EVIDENCE_TO_ACT) {
            w.evidence = 0;
            w.actions++;
            // Nudge first, reload if it recurs.
            const action = w.actions >= 2 ? 'reload' : 'nudge';
            step = { action, time, elapsed: time - prev.time, framesDelta };
            if (action === 'reload') return { next: { phase: 'disarmed' }, step };
        }
    } else {
        w.healthy = 0;
    }
    return { next: w.evalsLeft > 0 ? w : { phase: 'disarmed' }, step };
}
