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
                const ok = responseData as Extract<WorkerFetchResponse, { body: string }>;
                // ResponseInit has no url/redirected/type, so they're defined on the instance: IVS's
                // WASM rejects Spade/tracking responses without them with a NetworkError.
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
let hooked = false;
try {
    hooked = hookWorkerFetch();
} catch (e) {
    console.error('[AD DEBUG] Worker fetch hook setup failed:', e);
}
if (!hooked) {
    console.log('[AD DEBUG] Worker fetch not hooked: ads will not be blocked in this worker');
}
// Indirect eval runs Twitch's worker script in the worker's global scope, as its own worker script would.
try {
    // biome-ignore lint/complexity/noCommaOperator: (0, eval) is the standard indirect-eval form
    // biome-ignore lint/security/noGlobalEval: runs Twitch's own worker script, which a worker would otherwise load itself
    (0, eval)(workerString);
} catch (e) {
    console.error('[AD DEBUG] Worker eval failed — Twitch player logic not loaded:', e);
}
