export interface StallLadder {
    frozenTicks: number;
    fixAttempts: number;
    reloadUsed: boolean;
}

export type StallObservation = 'frozen' | 'healthy' | 'hold';

interface StallStep {
    action: 'none' | 'pause-play' | 'reload';
    capped: boolean;
}

const ESCALATE_AFTER_FIXES = 3;

export function createStallLadder(): StallLadder {
    return { frozenTicks: 0, fixAttempts: 0, reloadUsed: false };
}

export function resetStallLadder(ladder: StallLadder): void {
    ladder.frozenTicks = 0;
    ladder.fixAttempts = 0;
    ladder.reloadUsed = false;
}

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
