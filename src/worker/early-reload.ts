// Early reload during a prolonged freeze (every segment of every poll stripped, the player
// replaying recovery segments): reload for fresh content. The state machine is
// AdBreak.EarlyReload (see EarlyReloadState in src/shared/types.ts).
//
// Bounded to one reload per ad in the pod (two when the recovery cache is thin), so reload loops
// are impossible. A reload the page skipped because the player was healthy is refunded.
import type { AdBreak, ReloadOutcome } from '../shared/types.ts';
import { requestReload } from './reload.ts';
import { state } from './state.ts';

/** A request the page hasn't answered in this long is treated as not done. */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Advance the machine for this poll: report the result of a reload that went through, give up on
 * an unanswered request, then fire a new reload if the freeze calls for one (unless `canFire` is
 * false: another reload is already under way). Call after stripAdSegments has updated the
 * break's freeze counters for this poll.
 */
export function stepEarlyReload(brk: AdBreak, pathLabel: string, canFire = true): void {
    const er = brk.EarlyReload;
    if (er.phase === 'reloaded') {
        // Classified on the freeze counter, not on ',live' in the returned playlist: injected
        // recovery segments are ',live' lines too, which made "still ads" read as "partial".
        if (!brk.IsStripping) {
            console.log('[AD DEBUG] Early reload result' + pathLabel + ': clean — freeze ended');
        } else if (brk.ConsecutiveAllStrippedPolls === 0) {
            console.log('[AD DEBUG] Early reload result' + pathLabel + ': partial — some live segments returned');
        } else {
            console.log('[AD DEBUG] Early reload result' + pathLabel + ': still ads — continuing recovery loop');
        }
        brk.EarlyReload = { phase: 'armed' };
    } else if (er.phase === 'requested' && Date.now() - er.at > REQUEST_TIMEOUT_MS) {
        console.log('[AD DEBUG] Early reload request unanswered — re-arming');
        brk.EarlyReload = { phase: 'armed' };
    }
    if (canFire) {
        maybeFire(brk, pathLabel);
    }
}

function maybeFire(brk: AdBreak, pathLabel: string): void {
    const recoverySize = brk.RecoverySegments.length;
    const recoveryThin = recoverySize < 3;
    const maxEarlyReloads = Math.max(recoveryThin ? 2 : 1, brk.PodLength);
    const effectiveThreshold = recoveryThin ? 1 : state.EarlyReloadPollThreshold;
    if (
        brk.EarlyReload.phase !== 'armed' ||
        state.EarlyReloadPollThreshold <= 0 ||
        brk.ConsecutiveAllStrippedPolls < effectiveThreshold ||
        brk.EarlyReloadCount >= maxEarlyReloads
    ) {
        return;
    }
    brk.EarlyReloadCount++;
    brk.EarlyReloadAtPoll = brk.TotalAllStrippedPolls || brk.ConsecutiveAllStrippedPolls;
    const reason = recoveryThin ? ' (thin recovery cache: ' + recoverySize + ' segments)' : '';
    console.log(
        '[AD DEBUG] Early reload triggered' +
            pathLabel +
            ' — ' +
            brk.ConsecutiveAllStrippedPolls +
            ' consecutive all-stripped polls' +
            reason +
            ' [' +
            brk.EarlyReloadCount +
            '/' +
            maxEarlyReloads +
            ']',
    );
    const at = Date.now();
    // Set before posting: the harness (and a synchronous page) can answer inside requestReload.
    const pending = { phase: 'requested' as const, requestId: 0, at };
    brk.EarlyReload = pending;
    pending.requestId = requestReload('early', (outcome) => onOutcome(brk, pending.requestId, outcome));
}

function onOutcome(brk: AdBreak, requestId: number, outcome: ReloadOutcome): void {
    const er = brk.EarlyReload;
    // Stale answer: the request timed out and the machine moved on.
    if (er.phase !== 'requested' || er.requestId !== requestId) return;
    if (outcome === 'reloaded') {
        brk.EarlyReload = { phase: 'reloaded' };
    } else if (outcome === 'skipped-healthy') {
        // Player was fine; give the budget back so a later real stall can still reload.
        brk.EarlyReloadCount = Math.max(0, brk.EarlyReloadCount - 1);
        brk.EarlyReload = { phase: 'armed' };
        console.log('[AD DEBUG] Early reload skipped by main thread (player healthy) — re-armed, budget refunded');
    } else {
        brk.EarlyReload = { phase: 'armed' };
    }
}
