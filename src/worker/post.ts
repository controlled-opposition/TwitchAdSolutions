import type { WorkerToPageMessage } from '../shared/types.ts';

export function postToPage(message: WorkerToPageMessage): void {
    postMessage(message);
}
