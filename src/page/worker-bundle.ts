import type { WorkerInit } from '../shared/types.ts';

declare function __VAFT_WORKER_BUNDLE__(): void;

export function runWorker(__vaftInit: WorkerInit): void {
    __VAFT_WORKER_BUNDLE__();
}
