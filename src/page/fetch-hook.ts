import { playerBufferState, state } from './state.ts';
import { maskAsNative } from './mask.ts';
import { postTwitchWorkerMessage } from './workers.ts';

// CSAI ad-request counters, keyed by type and split on whether a detected ad break was in
// progress. The no-break tally is the point: an ad served while the m3u8 carried no markers
// is one vaft never sees — nothing stripped, no backup searched, nothing else in the log.
// The previous once-per-session latch could not surface that at all.
const csaiRequestCounts: Record<string, { inBreak: number; noBreak: number }> = Object.create(null);
export function countCsaiRequest(csaiType: string, transport: 'fetch' | 'xhr') {
    const inBreak = playerBufferState.inAdBreak === true;
    let c = csaiRequestCounts[csaiType];
    if (!c) {
        c = { inBreak: 0, noBreak: 0 };
        csaiRequestCounts[csaiType] = c;
    }
    const n = inBreak ? ++c.inBreak : ++c.noBreak;
    // First, then every 10th. Both totals and the channel ride on every line so a dump
    // spanning several channels reads as a ratio without the whole session in hand.
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
// Hook fetch() in the window scope to capture auth headers and modify player type requests
export function hookFetch() {
    console.log('[AD DEBUG] Window fetch hook installed');
    let hasLoggedHeaders = false;
    const realFetch = window.fetch;
    window.realFetch = realFetch;
    window.fetch = maskAsNative(function (this: unknown, url, init) {
        if (typeof url === 'string') {
            if (url.includes('gql')) {
                // init can be absent (a bare fetch(url) used to throw here and fail the request)
                // or carry a Headers instance; only a plain-object header map is read.
                const headers = (init?.headers || {}) as Record<string, unknown>;
                let deviceId = headers['X-Device-Id'];
                if (typeof deviceId !== 'string') {
                    deviceId = headers['Device-ID'];
                }
                if (typeof deviceId === 'string' && state.GQLDeviceID !== deviceId) {
                    state.GQLDeviceID = deviceId;
                    postTwitchWorkerMessage('UpdateDeviceId', state.GQLDeviceID);
                }
                const headerClientVersion = headers['Client-Version'];
                if (typeof headerClientVersion === 'string' && headerClientVersion !== state.ClientVersion) {
                    state.ClientVersion = headerClientVersion;
                    postTwitchWorkerMessage('UpdateClientVersion', state.ClientVersion);
                }
                const headerClientSession = headers['Client-Session-Id'];
                if (typeof headerClientSession === 'string' && headerClientSession !== state.ClientSession) {
                    state.ClientSession = headerClientSession;
                    postTwitchWorkerMessage('UpdateClientSession', state.ClientSession);
                }
                const headerClientIntegrityHeader = headers['Client-Integrity'];
                if (
                    typeof headerClientIntegrityHeader === 'string' &&
                    headerClientIntegrityHeader !== state.ClientIntegrityHeader
                ) {
                    state.ClientIntegrityHeader = headerClientIntegrityHeader;
                    postTwitchWorkerMessage('UpdateClientIntegrityHeader', state.ClientIntegrityHeader);
                }
                const headerAuthorizationHeader = headers['Authorization'];
                if (
                    typeof headerAuthorizationHeader === 'string' &&
                    headerAuthorizationHeader !== state.AuthorizationHeader
                ) {
                    state.AuthorizationHeader = headerAuthorizationHeader;
                    postTwitchWorkerMessage('UpdateAuthorizationHeader', state.AuthorizationHeader);
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
                // Get rid of mini player above chat - TODO: Reject this locally instead of having server reject it
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
                const csaiType = url.includes('bp=midroll')
                    ? 'midroll'
                    : url.includes('bp=preroll')
                      ? 'preroll'
                      : 'unknown';
                countCsaiRequest(csaiType, 'fetch');
            }
        }
        // biome-ignore lint/suspicious/noExplicitAny: forwards the caller's arguments untouched (the real fetch has overloads)
        return realFetch.apply(this, arguments as any);
    }, 'fetch');
}
// Hook XHR to detect CSAI ad requests that bypass fetch
export function hookXhr() {
    const realXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = maskAsNative(function (this: XMLHttpRequest, _method: string, url: string | URL) {
        if (typeof url === 'string' && url.includes('edge.ads.twitch.tv')) {
            const csaiType = url.includes('bp=midroll')
                ? 'midroll'
                : url.includes('bp=preroll')
                  ? 'preroll'
                  : 'unknown';
            countCsaiRequest(csaiType, 'xhr');
        }
        // biome-ignore lint/suspicious/noExplicitAny: forwards whichever open() overload the caller used
        return realXHROpen.apply(this, arguments as any);
    }, 'open');
}
