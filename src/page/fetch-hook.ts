import { GQL_HEADER_RELAYS } from '../shared/config.ts';
import { installHook } from '../shared/hook.ts';
import { maskAsNative } from './mask.ts';
import { playerBufferState, state } from './state.ts';
import { postTwitchWorkerMessage } from './workers.ts';

const csaiRequestCounts: Record<string, { inBreak: number; noBreak: number }> = Object.create(null);
function countCsaiRequest(url: string, transport: 'fetch' | 'xhr') {
    const csaiType = url.includes('bp=midroll') ? 'midroll' : url.includes('bp=preroll') ? 'preroll' : 'unknown';
    const inBreak = playerBufferState.inAdBreak === true;
    let c = csaiRequestCounts[csaiType];
    if (!c) {
        c = { inBreak: 0, noBreak: 0 };
        csaiRequestCounts[csaiType] = c;
    }
    const n = inBreak ? ++c.inBreak : ++c.noBreak;
    if (n !== 1 && n % 10 !== 0) {
        return;
    }
    const chan = playerBufferState.channelName ? ' on ' + playerBufferState.channelName : '';
    console.log(
        '[AD DEBUG] CSAI ad request (' +
            transport +
            ') — type: ' +
            csaiType +
            chan +
            (inBreak ? ' during a detected break' : ' with NO break detected — vaft never saw this ad') +
            ' | this type so far: ' +
            c.noBreak +
            ' unseen, ' +
            c.inBreak +
            ' during breaks' +
            (n === 1 ? ' (client-side insertion, not blockable via m3u8)' : ''),
    );
}
function firstStringHeader(headers: Record<string, unknown>, names: readonly string[]): string | undefined {
    for (const name of names) {
        const value = headers[name];
        if (typeof value === 'string') {
            return value;
        }
    }
    return undefined;
}
export function hookFetch() {
    let hasLoggedHeaders = false;
    const realFetch = window.fetch;
    installHook(window, 'realFetch', realFetch, 'window.realFetch');
    const hook = maskAsNative(function (this: unknown, url: RequestInfo | URL, init?: RequestInit) {
        if (typeof url === 'string') {
            if (url.includes('gql')) {
                const headers = (init?.headers || {}) as Record<string, unknown>;
                for (const relay of GQL_HEADER_RELAYS) {
                    const value = firstStringHeader(headers, relay.headers);
                    if (value !== undefined && state[relay.field] !== value) {
                        state[relay.field] = value;
                        postTwitchWorkerMessage(relay.key, value);
                    }
                }
                if (!hasLoggedHeaders && state.GQLDeviceID && state.AuthorizationHeader) {
                    hasLoggedHeaders = true;
                    console.log(
                        '[AD DEBUG] GQL headers captured — DeviceId: ' +
                            (state.GQLDeviceID ? 'yes' : 'no') +
                            ', Auth: ' +
                            (state.AuthorizationHeader ? 'yes' : 'no') +
                            ', Integrity: ' +
                            (state.ClientIntegrityHeader ? 'yes' : 'no'),
                    );
                }
                // picture-by-picture tokens feed the mini player above chat; an empty body makes GQL reject it.
                if (
                    init &&
                    typeof init.body === 'string' &&
                    init.body.includes('PlaybackAccessToken') &&
                    init.body.includes('picture-by-picture')
                ) {
                    init.body = '';
                }
                if (
                    state.ForceAccessTokenPlayerType &&
                    init &&
                    typeof init.body === 'string' &&
                    init.body.includes('PlaybackAccessToken')
                ) {
                    let replacedPlayerType = '';
                    const newBody = JSON.parse(init.body);
                    if (Array.isArray(newBody)) {
                        for (let i = 0; i < newBody.length; i++) {
                            if (
                                newBody[i]?.variables?.playerType &&
                                newBody[i]?.variables?.playerType !== state.ForceAccessTokenPlayerType
                            ) {
                                replacedPlayerType = newBody[i].variables.playerType;
                                newBody[i].variables.playerType = state.ForceAccessTokenPlayerType;
                            }
                        }
                    } else {
                        if (
                            newBody?.variables?.playerType &&
                            newBody?.variables?.playerType !== state.ForceAccessTokenPlayerType
                        ) {
                            replacedPlayerType = newBody.variables.playerType;
                            newBody.variables.playerType = state.ForceAccessTokenPlayerType;
                        }
                    }
                    if (replacedPlayerType) {
                        console.log(
                            `[AD DEBUG] Replaced '${replacedPlayerType}' player type with '${state.ForceAccessTokenPlayerType}' player type`,
                        );
                        init.body = JSON.stringify(newBody);
                    }
                }
            }
            if (url.includes('edge.ads.twitch.tv')) {
                countCsaiRequest(url, 'fetch');
            }
        }
        // biome-ignore lint/suspicious/noExplicitAny: forwards the caller's arguments untouched (the real fetch has overloads)
        return realFetch.apply(this, arguments as any);
    }, 'fetch');
    if (installHook(window, 'fetch', hook, 'window fetch')) {
        console.log('[AD DEBUG] Window fetch hook installed');
    }
}
export function hookXhr() {
    const realXHROpen = XMLHttpRequest.prototype.open;
    const hook = maskAsNative(function (this: XMLHttpRequest, _method: string, url: string | URL) {
        if (typeof url === 'string' && url.includes('edge.ads.twitch.tv')) {
            countCsaiRequest(url, 'xhr');
        }
        // biome-ignore lint/suspicious/noExplicitAny: forwards whichever open() overload the caller used
        return realXHROpen.apply(this, arguments as any);
    }, 'open') as typeof realXHROpen;
    installHook(XMLHttpRequest.prototype, 'open', hook, 'XMLHttpRequest.open');
}
