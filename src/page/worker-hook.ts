import { pickSharedConfig } from '../shared/config.ts';
import type {
    AdBlockBannerMessage,
    WorkerFetchRequest,
    WorkerFetchResponse,
    WorkerInit,
    WorkerToPageMessage,
} from '../shared/types.ts';
import { getWasmWorkerJs } from '../shared/wasm-worker.ts';
import { cancelDriftCorrection } from './drift.ts';
import { installHook } from '../shared/hook.ts';
import { maskAsNative } from './mask.ts';
import { updateAdblockBanner } from './overlay.ts';
import { doTwitchPlayerTask, type PlayerTaskOutcome } from './player.ts';
import { playerBufferState, runtime, state } from './state.ts';
import { runWorker } from './worker-bundle.ts';
import { postTwitchWorkerMessage, twitchWorkers } from './workers.ts';

// Markers of other extensions' Worker overrides (TwitchNoSub).
const workerStringConflicts = [
    'twitch',
    'isVariantA', // TwitchNoSub
];
const workerStringReinsert = [
    'isVariantA', // TwitchNoSub (prior to (0.9))
    'besuper/', // TwitchNoSub (0.9)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal marker string from TwitchNoSub's worker source
    '${patch_url}', // TwitchNoSub (0.9.1)
];
function getCleanWorker(worker: typeof Worker): typeof Worker | null {
    let root = null;
    let parent = null;
    let proto = worker;
    while (proto) {
        const workerString = proto.toString();
        if (workerStringConflicts.some((x) => workerString.includes(x))) {
            if (parent !== null) {
                // setPrototypeOf throws on a link another extension froze; skip that link.
                try {
                    Object.setPrototypeOf(parent, Object.getPrototypeOf(proto));
                } catch {}
            }
        } else {
            if (root === null) {
                root = proto;
            }
            parent = proto;
        }
        proto = Object.getPrototypeOf(proto);
    }
    return root;
}
function getWorkersForReinsert(worker: typeof Worker): object[] {
    const result = [];
    let proto = worker;
    while (proto) {
        const workerString = proto.toString();
        if (workerStringReinsert.some((x) => workerString.includes(x))) {
            result.push(proto);
        }
        proto = Object.getPrototypeOf(proto);
    }
    return result;
}
function reinsertWorkers(worker: typeof Worker, reinsert: object[]): typeof Worker {
    let parent = worker;
    for (let i = 0; i < reinsert.length; i++) {
        try {
            Object.setPrototypeOf(reinsert[i], parent);
        } catch {}
        parent = reinsert[i] as typeof Worker;
    }
    return parent;
}
export function isValidWorker(worker: { toString(): string }): boolean {
    const workerString = worker.toString();
    const hasConflict = workerStringConflicts.some((x) => workerString.includes(x));
    const hasReinsert = workerStringReinsert.some((x) => workerString.includes(x));
    if (hasConflict && !hasReinsert) {
        console.log(
            '[AD DEBUG] Worker rejected — conflict string found: ' +
                workerStringConflicts.filter((x) => workerString.includes(x)).join(', '),
        );
    }
    return !hasConflict || hasReinsert;
}
let injectedBlobUrl: string | null = null;
let originalRevokeObjectURL: typeof URL.revokeObjectURL | null = null;
export function hookWindowWorker() {
    // Prevent Twitch from revoking our injected worker blob URL
    if (!URL.revokeObjectURL.__tasMasked) {
        const realRevokeObjectURL = URL.revokeObjectURL;
        originalRevokeObjectURL = realRevokeObjectURL;
        const hook = maskAsNative(function (this: typeof URL, url: string) {
            if (url === injectedBlobUrl) return;
            return realRevokeObjectURL.call(this, url);
        }, 'revokeObjectURL');
        hook.__tasMasked = true;
        // If this fails, the worker has normally fetched its script before Twitch revokes the URL.
        installHook(URL, 'revokeObjectURL', hook, 'URL.revokeObjectURL');
    }
    const reinsert = getWorkersForReinsert(window.Worker);
    const cleanWorker = getCleanWorker(window.Worker) || window.Worker;
    const newWorker = class Worker extends cleanWorker {
        constructor(twitchBlobUrl: string | URL, options?: WorkerOptions) {
            twitchBlobUrl = String(twitchBlobUrl);
            let isTwitchWorker = false;
            try {
                isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
            } catch {}
            if (!isTwitchWorker) {
                super(twitchBlobUrl, options);
                console.log('[AD DEBUG] Non-Twitch worker skipped: ' + twitchBlobUrl);
                return;
            }
            let prefetchedWorkerJs = null;
            try {
                prefetchedWorkerJs = getWasmWorkerJs(twitchBlobUrl);
            } catch {}
            if (!prefetchedWorkerJs) {
                super(twitchBlobUrl, options);
                console.log('[AD DEBUG] Failed to fetch worker JS — falling back to unmodified worker');
                return;
            }
            const alreadyHooked = prefetchedWorkerJs.includes('hookWorkerFetch');
            if (alreadyHooked) {
                super(twitchBlobUrl, options);
                console.log('[AD DEBUG] Worker already hooked — reusing without re-injection');
            } else {
                console.log('[AD DEBUG] Worker intercepted — injecting ad-block hooks');
                if (injectedBlobUrl && originalRevokeObjectURL) {
                    try {
                        originalRevokeObjectURL.call(URL, injectedBlobUrl);
                    } catch {}
                }
                const init: WorkerInit = { twitchBlobUrl, config: pickSharedConfig(state) };
                const newBlobStr = `(${runWorker.toString()})(${JSON.stringify(init)});`;
                injectedBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                super(injectedBlobUrl, options);
            }
            twitchWorkers.length = 0;
            twitchWorkers.push(this);
            this.addEventListener('message', (e: MessageEvent<WorkerToPageMessage>) => {
                if (e.data.key === 'UpdateAdBlockBanner') {
                    onAdBreakUpdate(e.data);
                } else if (e.data.key === 'PauseResumePlayer') {
                    doTwitchPlayerTask('pausePlay');
                } else if (e.data.key === 'ReloadPlayer') {
                    const { kind, requestId } = e.data;
                    let outcome: PlayerTaskOutcome = 'not-done';
                    try {
                        outcome = doTwitchPlayerTask('reload', kind);
                    } finally {
                        if (requestId) {
                            postTwitchWorkerMessage('ReloadResult', {
                                requestId,
                                outcome: outcome === 'done' ? 'reloaded' : outcome,
                            });
                        }
                    }
                }
            });
            this.addEventListener('message', async (event: MessageEvent<WorkerToPageMessage>) => {
                if (event.data.key === 'FetchRequest') {
                    const fetchRequest = event.data.value;
                    const responseData = await handleWorkerFetchRequest(fetchRequest);
                    this.postMessage({
                        key: 'FetchResponse',
                        value: responseData,
                    });
                }
            });
            // IVS's WASM worker can die on a RuntimeError (e.g. "index out of bounds"), firing several
            // error events. A hard reload makes Twitch spawn a new worker with the new player instance.
            let crashed = false;
            this.addEventListener('error', (e: ErrorEvent) => {
                if (crashed) return;
                crashed = true;
                console.log(
                    '[AD DEBUG] IVS WASM worker crashed: ' +
                        ((e && e.message) || 'unknown error') +
                        ' — triggering hard reload to recover',
                );
                try {
                    doTwitchPlayerTask('reload', 'early');
                } catch (err) {
                    console.log('[AD DEBUG] Worker crash recovery failed: ' + (err as Error).message);
                }
            });
        }
    };
    let workerInstance = reinsertWorkers(newWorker, reinsert);
    Object.defineProperty(window, 'Worker', {
        get: function () {
            return workerInstance;
        },
        set: function (value) {
            if (isValidWorker(value)) {
                workerInstance = value;
            } else {
                console.log('Attempt to set twitch worker denied');
            }
        },
    });
}
function onAdBreakUpdate(data: AdBlockBannerMessage) {
    runtime.isActivelyStrippingAds = !!data.isStrippingAdSegments;
    if (data.hasAds !== playerBufferState.inAdBreak) {
        playerBufferState.lastBackupSwitchAt = Date.now();
        if (!data.hasAds) {
            playerBufferState.position = 0;
        }
    }
    playerBufferState.inAdBreak = !!data.hasAds;
    if (data.hasAds) {
        cancelDriftCorrection();
    }
    updateAdblockBanner(data);
}
async function handleWorkerFetchRequest(fetchRequest: WorkerFetchRequest): Promise<WorkerFetchResponse> {
    // Twitch GQL normally answers in <1s; without a timeout a hung request stalls the worker's
    // backup search until the browser gives up.
    const controller = new AbortController();
    const timeoutMs = 5000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await window.realFetch(fetchRequest.url, {
            ...fetchRequest.options,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const responseBody = await response.text();
        const responseObject = {
            id: fetchRequest.id,
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            redirected: response.redirected,
            type: response.type,
            url: response.url,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseBody,
        };
        return responseObject;
    } catch (error) {
        clearTimeout(timeoutId);
        return {
            id: fetchRequest.id,
            error:
                (error as Error).name === 'AbortError'
                    ? 'GQL fetch timeout (' + timeoutMs / 1000 + 's)'
                    : (error as Error).message,
        };
    }
}
