// After an ad break the decoder can stop emitting frames while the audio clock keeps currentTime
// advancing, which a currentTime-based freeze check can't see (GosuDRM/TTV-AB _checkPostBreakWedge).

export type WedgeWatch =
    | { phase: 'disarmed' }
    | {
          phase: 'watching';
          evalsLeft: number;
          last: { time: number; frames: number } | null;
          evidence: number;
          healthy: number;
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

export function wedgeSample(watch: WedgeWatch, time: number, frames: number): { next: WedgeWatch; step: WedgeStep } {
    if (watch.phase !== 'watching') return { next: watch, step: { action: 'none' } };
    const prev = watch.last;
    const w = { ...watch, last: { time, frames } };
    if (!prev || time <= prev.time + MIN_ADVANCE_S) {
        return { next: w, step: { action: 'none' } };
    }
    w.evalsLeft--;
    const framesDelta = frames - prev.frames;
    let step: WedgeStep = { action: 'none' };
    if (framesDelta < 0) {
        // totalVideoFrames went backwards: the element reloaded its media, so this isn't evidence.
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
            const action = w.actions >= 2 ? 'reload' : 'nudge';
            step = { action, time, elapsed: time - prev.time, framesDelta };
            if (action === 'reload') return { next: { phase: 'disarmed' }, step };
        }
    } else {
        w.healthy = 0;
    }
    return { next: w.evalsLeft > 0 ? w : { phase: 'disarmed' }, step };
}
