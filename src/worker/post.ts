import type { WorkerToPageMessage } from '../shared/types.ts';

/** Post a message to the page. Typed wrapper: the global postMessage accepts anything. */
export function postToPage(message: WorkerToPageMessage): void {
    postMessage(message);
}
