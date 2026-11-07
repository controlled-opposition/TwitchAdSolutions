// Placeholder for the worker bundle. scripts/build.js builds src/worker/index.ts on its own and
// splices it into the userscript in place of the __VAFT_WORKER_BUNDLE__() call, so the shipped
// runWorker() holds the whole worker as one self-contained function. hookWindowWorker() starts a
// worker with its source text: `(${runWorker})(init)`.
import type { WorkerInit } from '../shared/types.ts';

declare function __VAFT_WORKER_BUNDLE__(): void;

export function runWorker(__vaftInit: WorkerInit): void {
    __VAFT_WORKER_BUNDLE__();
}
