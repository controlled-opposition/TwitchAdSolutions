// Stall-recovery ladder for the buffer monitor:
//
//     healthy ──frozen tick──▶ suspect(1..N-1) ──Nth──▶ fix: pause/play ×2, then one reload per
//        ▲                                                    recovery window, then pause/play only
//        └──────────── healthy tick (or a new channel / <video> element): reset ──────────────┘
//
// A "hold" tick (the element isn't trying to play: init, seek, reload teardown) neither counts
// nor resets, so a real stall interrupted by a brief init dip resumes counting.

export interface StallLadder {
    /** Consecutive frozen ticks since the last fix. */
    frozenTicks: number;
    /** Fixes in this recovery window; the third escalates to a reload. */
    fixAttempts: number;
    /** This recovery window already spent its reload (the reload cap). */
    reloadUsed: boolean;
}

export type StallObservation = 'frozen' | 'healthy' | 'hold';

export interface StallStep {
    action: 'none' | 'pause-play' | 'reload';
    /** Set when the ladder wanted to escalate but the reload cap held it at pause/play. */
    capped: boolean;
}

/** Fixes before escalating to a reload. */
const ESCALATE_AFTER_FIXES = 3;

export function createStallLadder(): StallLadder {
    return { frozenTicks: 0, fixAttempts: 0, reloadUsed: false };
}

/** Start a fresh recovery window: no stall seen, no fix attempted, reload budget restored. */
export function resetStallLadder(ladder: StallLadder): void {
    ladder.frozenTicks = 0;
    ladder.fixAttempts = 0;
    ladder.reloadUsed = false;
}

/**
 * Advance the ladder by one monitor tick.
 * @param frozenTicksToFix frozen ticks in a row that trigger a fix (PlayerBufferingSameStateCount)
 * @param reloadCap at most one reload per recovery window (off: twitchAdSolutions_disableReloadCap)
 */
export function stallTick(
    ladder: StallLadder,
    observation: StallObservation,
    frozenTicksToFix: number,
    reloadCap: boolean,
): StallStep {
    if (observation === 'hold') {
        return { action: 'none', capped: false };
    }
    if (observation === 'healthy') {
        resetStallLadder(ladder);
        return { action: 'none', capped: false };
    }
    ladder.frozenTicks++;
    if (ladder.frozenTicks < frozenTicksToFix) {
        return { action: 'none', capped: false };
    }
    ladder.frozenTicks = 0;
    ladder.fixAttempts++;
    const wouldEscalate = ladder.fixAttempts >= ESCALATE_AFTER_FIXES;
    if (wouldEscalate && (!reloadCap || !ladder.reloadUsed)) {
        ladder.fixAttempts = 0;
        ladder.reloadUsed = true;
        return { action: 'reload', capped: false };
    }
    return { action: 'pause-play', capped: wouldEscalate };
}
