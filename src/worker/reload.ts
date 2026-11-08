import type { ReloadKind, ReloadOutcome } from '../shared/types.ts';
import { postToPage } from './post.ts';

let nextRequestId = 1;
const pendingReloads = new Map<number, (outcome: ReloadOutcome) => void>();

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

export function settleReload(requestId: number, outcome: ReloadOutcome): void {
    const onOutcome = pendingReloads.get(requestId);
    if (!onOutcome) return;
    pendingReloads.delete(requestId);
    onOutcome(outcome);
}
