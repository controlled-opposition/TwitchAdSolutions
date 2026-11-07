import type { PageToWorkerValues } from '../shared/types.ts';

export const twitchWorkers: Worker[] = [];
export function postTwitchWorkerMessage<K extends keyof PageToWorkerValues>(key: K, value?: PageToWorkerValues[K]) {
    twitchWorkers.forEach((worker) => {
        worker.postMessage({ key: key, value: value });
    });
}
