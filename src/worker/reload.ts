// Player reloads the worker asks the page for. A request with an outcome callback carries a
// requestId; the page answers it with a ReloadResult naming what it actually did (reloaded,
// skipped because the player was healthy, or couldn't). Requests without a callback get no answer.
import type { ReloadKind, ReloadOutcome } from '../shared/types.ts';
import { postToPage } from './post.ts';

let nextRequestId = 1;
const pendingReloads = new Map<number, (outcome: ReloadOutcome) => void>();

/** Ask the page to reload the player. Returns the request id (0 when no answer was asked for). */
export function requestReload(kind: ReloadKind, onOutcome?: (outcome: ReloadOutcome) => void): number {
    if (!onOutcome) {
        postToPage({ key: 'ReloadPlayer', kind });
        return 0;
    }
    const requestId = nextRequestId++;
    pendingReloads.set(requestId, onOutcome);
    postToPage({ key: 'ReloadPlayer', kind, requestId });
    return requestId;
}

/** The page's ReloadResult for a request. Unknown ids (already settled, or another copy's) are ignored. */
export function settleReload(requestId: number, outcome: ReloadOutcome): void {
    const onOutcome = pendingReloads.get(requestId);
    if (!onOutcome) return;
    pendingReloads.delete(requestId);
    onOutcome(outcome);
}
