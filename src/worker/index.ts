// Worker bundle entry. The page wraps this bundle in a function and starts it as the injected
// worker's script (see hookWindowWorker in src/page/worker-hook.ts), passing a WorkerInit:
//
//     (function runWorker(__vaftInit) { <this bundle> })({ twitchBlobUrl, config });
//
// It installs vaft's hooks, then runs Twitch's own worker code in the same worker.
import { getWasmWorkerJs } from '../shared/wasm-worker.ts';
import type { PageToWorkerMessage, WorkerFetchResponse, WorkerInit } from '../shared/types.ts';
import { hookWorkerFetch } from './fetch-hook.ts';
import { pendingFetchRequests } from './gql.ts';
import { state } from './state.ts';
import { pruneStreamInfos } from './stream-info.ts';

declare const __vaftInit: WorkerInit;

declare global {
    var __tasPruneInterval: ReturnType<typeof setInterval> | undefined;
}

const workerString = getWasmWorkerJs(__vaftInit.twitchBlobUrl);
if (!self.__tasPruneInterval) {
    self.__tasPruneInterval = setInterval(pruneStreamInfos, 5 * 60 * 1000);
}
Object.assign(state, __vaftInit.config);
self.addEventListener('message', function (e: MessageEvent<PageToWorkerMessage>) {
    if (e.data.key === 'UpdateClientVersion') {
        state.ClientVersion = e.data.value;
    } else if (e.data.key === 'UpdateClientSession') {
        state.ClientSession = e.data.value;
    } else if (e.data.key === 'UpdateClientId') {
        state.ClientID = e.data.value;
    } else if (e.data.key === 'UpdateDeviceId') {
        state.GQLDeviceID = e.data.value;
    } else if (e.data.key === 'UpdateClientIntegrityHeader') {
        state.ClientIntegrityHeader = e.data.value;
    } else if (e.data.key === 'UpdateAuthorizationHeader') {
        state.AuthorizationHeader = e.data.value;
    } else if (e.data.key === 'FetchResponse') {
        const responseData = e.data.value;
        const pending = pendingFetchRequests.get(responseData.id);
        if (pending) {
            const { resolve, reject, timeoutId } = pending;
            clearTimeout(timeoutId);
            pendingFetchRequests.delete(responseData.id);
            if (responseData.error) {
                reject(new Error(responseData.error));
            } else {
                // Not narrowed by the truthiness check (an empty error string lands here too, as it always has).
                const ok = responseData as Extract<WorkerFetchResponse, { body: string }>;
                // Create a Response object from the response data.
                // Response constructor only takes status/statusText/headers — url/redirected/type
                // must be defined on the instance. IVS WASM validates these (Spade/tracking
                // requests) and throws NetworkError if they're missing — TTV-AB v6.3.5 fix.
                const response = new Response(ok.body, {
                    status: ok.status,
                    statusText: ok.statusText,
                    headers: ok.headers,
                });
                try {
                    Object.defineProperty(response, 'url', { value: ok.url || '', configurable: true });
                    Object.defineProperty(response, 'redirected', {
                        value: !!ok.redirected,
                        configurable: true,
                    });
                    Object.defineProperty(response, 'type', {
                        value: ok.type || 'basic',
                        configurable: true,
                    });
                } catch {}
                resolve(response);
            }
        }
    } else if (e.data.key === 'TriggeredPlayerReload') {
        state.HasTriggeredPlayerReload = true;
    } else if (e.data.key === 'ReloadSkipped') {
        // Main thread refused the reload (player healthy) — clear the
        // early-reload flags so we can re-fire if the player later stalls.
        // Without this clear, the worker's EarlyReloadTriggered /
        // EarlyReloadAwaitingResult flags stay set after a healthy-skip,
        // blocking subsequent early-reload firings in the same break even
        // if a later poll legitimately calls for one.
        let cleared = false;
        for (const channel in state.StreamInfos) {
            const si = state.StreamInfos[channel];
            if (si && si.EarlyReloadTriggered) {
                si.EarlyReloadTriggered = false;
                si.EarlyReloadAwaitingResult = false;
                si.EarlyReloadCount = Math.max(0, (si.EarlyReloadCount || 0) - 1);
                cleared = true;
            }
        }
        if (cleared) {
            console.log(
                '[AD DEBUG] Reload skipped by main thread (player healthy) — early reload state cleared, can retry',
            );
        }
    } else if (e.data.key === 'SimulateAds') {
        state.SimulatedAdsDepth = e.data.value;
        console.log('SimulatedAdsDepth: ' + state.SimulatedAdsDepth);
    } else if (e.data.key === 'AllSegmentsAreAdSegments') {
        state.AllSegmentsAreAdSegments = !state.AllSegmentsAreAdSegments;
        console.log('AllSegmentsAreAdSegments: ' + state.AllSegmentsAreAdSegments);
    }
});
// Whatever happens here, Twitch's code below must still run: an unhooked worker plays the
// stream with ads, a worker that never runs Twitch's code plays nothing.
let hooked = false;
try {
    hooked = hookWorkerFetch();
} catch (e) {
    console.error('[AD DEBUG] Worker fetch hook setup failed:', e);
}
if (!hooked) {
    console.log('[AD DEBUG] Worker fetch not hooked: ads will not be blocked in this worker');
}
// Guard the eval — malformed workerString shouldn't silently break
// Twitch's player logic without a diagnostic. Worker stays alive on
// throw (vaft hooks installed above), but Twitch's logic wouldn't run.
// Indirect eval: Twitch's worker code must run in the worker's global scope, as it would
// as a worker script of its own, not inside this bundle's function scope.
try {
    // biome-ignore lint/complexity/noCommaOperator: (0, eval) is the standard indirect-eval form
    // biome-ignore lint/security/noGlobalEval: runs Twitch's own worker script, which a worker would otherwise load itself
    (0, eval)(workerString);
} catch (e) {
    console.error('[AD DEBUG] Worker eval failed — Twitch player logic not loaded:', e);
}
