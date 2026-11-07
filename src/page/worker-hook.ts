import { pickSharedConfig } from '../shared/config.ts';
import type { WorkerFetchRequest, WorkerFetchResponse, WorkerInit, WorkerToPageMessage } from '../shared/types.ts';
import { getWasmWorkerJs } from '../shared/wasm-worker.ts';
import { cancelDriftCorrection } from './drift.ts';
import { installHook } from '../shared/hook.ts';
import { maskAsNative } from './mask.ts';
import { updateAdblockBanner } from './overlay.ts';
import { doTwitchPlayerTask } from './player.ts';
import { playerBufferState, state } from './state.ts';
import { runWorker } from './worker-bundle.ts';
import { twitchWorkers } from './workers.ts';

// Strings used to detect and handle conflicting Twitch worker overrides (e.g. TwitchNoSub)
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
// Walk the Worker prototype chain and remove conflicting overrides
function getCleanWorker(worker: typeof Worker): typeof Worker | null {
    let root = null;
    let parent = null;
    let proto = worker;
    while (proto) {
        const workerString = proto.toString();
        if (workerStringConflicts.some((x) => workerString.includes(x))) {
            if (parent !== null) {
                // Another extension may have frozen Worker.prototype or set non-configurable
                // [[Prototype]]; setPrototypeOf throws TypeError in that case. Catch per-link
                // so a single foreign-frozen ring doesn't abort the whole chain walk.
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
        // Per-link try-catch: a foreign extension that froze a single proto entry
        // shouldn't break the whole reinsertion chain. Skip the failing link, keep going.
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
// Replace window.Worker to intercept Twitch's video worker and inject ad-blocking logic
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
        // Without it Twitch may revoke the injected blob URL early; the worker has normally
        // started by then, so this is logged and otherwise ignored.
        installHook(URL, 'revokeObjectURL', hook, 'URL.revokeObjectURL');
    }
    const reinsert = getWorkersForReinsert(window.Worker);
    const cleanWorker = getCleanWorker(window.Worker) || window.Worker;
    const newWorker = class Worker extends cleanWorker {
        constructor(twitchBlobUrl: string | URL, options?: WorkerOptions) {
            // Twitch passes a string; normalize so a URL object can't break the blob template below.
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
            // Pre-check: verify we can fetch the worker JS before injecting
            let prefetchedWorkerJs = null;
            try {
                prefetchedWorkerJs = getWasmWorkerJs(twitchBlobUrl);
            } catch {}
            if (!prefetchedWorkerJs) {
                super(twitchBlobUrl, options);
                console.log('[AD DEBUG] Failed to fetch worker JS — falling back to unmodified worker');
                return;
            }
            // Blob already carries our hooks: re-injecting would install
            // hookWorkerFetch twice and double-process every m3u8 response.
            // Reuse it as-is, but still register below so its messages are heard.
            const alreadyHooked = prefetchedWorkerJs.includes('hookWorkerFetch');
            if (alreadyHooked) {
                super(twitchBlobUrl, options);
                console.log('[AD DEBUG] Worker already hooked — reusing without re-injection');
            } else {
                console.log('[AD DEBUG] Worker intercepted — injecting ad-block hooks');
                // Revoke previous blob URL to prevent memory accumulation across worker replacements
                if (injectedBlobUrl && originalRevokeObjectURL) {
                    try {
                        originalRevokeObjectURL.call(URL, injectedBlobUrl);
                    } catch {}
                }
                // The worker bundle is one self-contained function (src/worker/index.ts), so its
                // source text runs as-is in the worker; the page's settings ride along as JSON.
                const init: WorkerInit = { twitchBlobUrl, config: pickSharedConfig(state) };
                const newBlobStr = `(${runWorker.toString()})(${JSON.stringify(init)});`;
                injectedBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                super(injectedBlobUrl, options);
            }
            twitchWorkers.length = 0;
            twitchWorkers.push(this);
            this.addEventListener('message', (e: MessageEvent<WorkerToPageMessage>) => {
                if (e.data.key === 'UpdateAdBlockBanner') {
                    updateAdblockBanner(e.data);
                    // Track backup stream switches (start and end of ad break)
                    if (e.data.hasAds !== !!playerBufferState.inAdBreak) {
                        playerBufferState.lastBackupSwitchAt = Date.now();
                        // Reset position tracking on ad-end so the stream switch gap isn't detected as a jump
                        if (!e.data.hasAds) {
                            playerBufferState.position = 0;
                        }
                    }
                    playerBufferState.inAdBreak = !!e.data.hasAds;
                    // Clear drift catch-up when ads start — don't run 1.1x during ad handling
                    if (e.data.hasAds) {
                        cancelDriftCorrection();
                    }
                } else if (e.data.key === 'PauseResumePlayer') {
                    doTwitchPlayerTask('pausePlay');
                } else if (e.data.key === 'ReloadPlayer') {
                    doTwitchPlayerTask('reload', e.data.kind);
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
            // Worker crash recovery — IVS WASM worker can fire RuntimeError
            // (e.g. "index out of bounds") and die. A single crash fires multiple
            // error events; dedupe via a local flag. On first error, trigger a
            // hard reload via the main reload path — Twitch re-spawns the worker
            // as part of the new player instance. The crashed flag limits this to
            // one reload per worker, so a crashing worker can't loop restarts.
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
async function handleWorkerFetchRequest(fetchRequest: WorkerFetchRequest): Promise<WorkerFetchResponse> {
    // 5s AbortController timeout. The worker uses this path for GQL requests
    // (access tokens + ad-spoof beacons). Without a timeout, a hung GQL endpoint
    // would block the worker's backup-search loop indefinitely (until browser's
    // ~30s default), turning a slow-network blip into a multi-second player
    // freeze during the ad break. 5s is well above normal Twitch GQL response
    // (<1s) but bounds worst-case wait. AbortError flows through the existing
    // catch + FailedBackupPlayerTypes lockout naturally.
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
