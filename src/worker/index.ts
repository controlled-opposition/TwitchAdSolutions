// Worker bundle entry. The page wraps this bundle in a function and starts it as the injected
// worker's script (see hookWindowWorker in src/page/worker-hook.ts), passing a WorkerInit:
//
//     (function runWorker(__vaftInit) { <this bundle> })({ twitchBlobUrl, config });
//
// It installs vaft's hooks, then runs Twitch's own worker code in the same worker.
import { GQL_HEADER_RELAYS } from '../shared/config.ts';
import { getWasmWorkerJs } from '../shared/wasm-worker.ts';
import type { PageToWorkerMessage, WorkerFetchResponse, WorkerInit } from '../shared/types.ts';
import { hookWorkerFetch } from './fetch-hook.ts';
import { pendingFetchRequests } from './gql.ts';
import { state } from './state.ts';
import { pruneStreamInfos } from './stream-info.ts';
import { settleReload } from './reload.ts';

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
    const headerRelay = GQL_HEADER_RELAYS.find((relay) => relay.key === e.data.key);
    if (headerRelay) {
        state[headerRelay.field] = e.data.value as string;
    } else if (e.data.key === 'UpdateClientId') {
        state.ClientID = e.data.value;
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
        // The page reloaded its player. Each stream stamps LastPlayerReload on its own next poll.
        for (const channel in state.StreamInfos) {
            state.StreamInfos[channel].ReloadPending = true;
        }
    } else if (e.data.key === 'ReloadResult') {
        settleReload(e.data.value.requestId, e.data.value.outcome);
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
