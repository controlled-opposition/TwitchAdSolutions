import { installHook } from '../shared/hook.ts';
import type { ResolutionInfo, StreamInfo } from '../shared/types.ts';
import { processM3U8 } from './m3u8.ts';
import { buildAvcOnlyMaster, getServerTimeFromM3u8, parseMasterVariants, replaceServerTimeInM3u8 } from './playlist.ts';
import { createStreamInfo } from './stream-info.ts';
import { state } from './state.ts';

// Builds the response for a playlist the hook rewrites. If rewriting throws, the playlist goes
// through unmodified (ads may show) rather than the request failing or never settling: the
// player's own retry would only hit the same error, and a request that never settles stalls it.
async function passThroughOnError(kind: string, original: string, rewrite: () => Promise<string>): Promise<Response> {
    try {
        return new Response(await rewrite());
    } catch (err) {
        console.log(
            '[AD DEBUG] Failed to process ' + kind + ' — passing it through unmodified: ' + (err as Error).message,
        );
        return new Response(original);
    }
}
// Hook fetch() in the worker scope to intercept m3u8 playlist requests and ad segments.
// Returns whether the hook is in place.
export function hookWorkerFetch(): boolean {
    console.log('[AD DEBUG] hookWorkerFetch (vaft)');
    const BLANK_MP4 = new Blob(
        [
            Uint8Array.from(
                atob(
                    'AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA',
                ),
                (c) => c.charCodeAt(0),
            ),
        ],
        { type: 'video/mp4' },
    );
    const realFetch = fetch;
    const hook = async function (this: unknown, url: RequestInfo | URL, options?: RequestInit): Promise<Response> {
        if (typeof url === 'string') {
            if (state.AdSegmentCache.has(url)) {
                return new Response(BLANK_MP4);
            }
            url = url.trimEnd();
            if (url.endsWith('m3u8')) {
                const response = await realFetch(url, options);
                if (response.status !== 200) {
                    return response;
                }
                const text = await response.text();
                return passThroughOnError('media playlist', text, async () =>
                    processM3U8(url as string, text, realFetch),
                );
            } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                state.V2API = url.includes('/api/v2/');
                const parsedUrl = new URL(url);
                // Twitch HLS master URLs always end in <channel>.m3u8.
                const channelName = parsedUrl.pathname.match(/([^/]+)(?=\.\w+$)/)?.[0] as string;
                if (state.ForceAccessTokenPlayerType) {
                    // parent_domains is used to determine if the player is embeded and stripping it gets rid of fake ads
                    parsedUrl.searchParams.delete('parent_domains');
                    url = parsedUrl.toString();
                }
                const response = await realFetch(url, options);
                if (response.status !== 200) {
                    return response;
                }
                const encodingsM3u8 = await response.text();
                return passThroughOnError('master playlist', encodingsM3u8, async () => {
                    const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                    let streamInfo: StreamInfo | null = state.StreamInfos[channelName];
                    if (streamInfo != null) {
                        // Probe one variant of the cached encodings; if it's gone, the stream
                        // probably restarted and the cache is dead. v2 API variant lines are raw CDN
                        // URLs without '.m3u8', hence the fallback pattern. No probe URL, or a probe
                        // that rejects, also counts as dead: this used to be fetch(undefined) / an
                        // uncaught rejection, which left this master-playlist request unresolved.
                        const probeUrl =
                            streamInfo.EncodingsM3U8.match(/^https:.*\.m3u8$/m)?.[0] ||
                            streamInfo.EncodingsM3U8.match(/^https:\/\/\S+$/m)?.[0];
                        let cacheAlive = false;
                        if (probeUrl) {
                            try {
                                cacheAlive = (await realFetch(probeUrl)).status === 200;
                            } catch {}
                        }
                        if (!cacheAlive) {
                            streamInfo = null;
                        }
                    }
                    if (streamInfo == null) {
                        // A new StreamInfo starts with no reload pending (ReloadPending is per
                        // stream), so a reload on the previous session can't bleed into this one.
                        console.log(
                            '[AD DEBUG] New stream session — channel: ' +
                                channelName +
                                ', API: ' +
                                (state.V2API ? 'v2' : 'v1'),
                        );
                        state.StreamInfos[channelName] = streamInfo = createStreamInfo(
                            channelName,
                            encodingsM3u8,
                            parsedUrl.search,
                        );
                        const resolutionList: ResolutionInfo[] = [];
                        for (const { url, resolution } of parseMasterVariants(encodingsM3u8)) {
                            if (resolution) {
                                streamInfo.Urls[url] = resolution;
                                resolutionList.push(resolution);
                            }
                            state.StreamInfosByUrl[url] = streamInfo;
                        }
                        if (resolutionList.length === 0) {
                            console.log(
                                '[AD DEBUG] No resolutions parsed from encodings m3u8 — Twitch may have changed the format',
                            );
                        }
                        streamInfo.ModifiedM3U8 = buildAvcOnlyMaster(encodingsM3u8, resolutionList);
                    }
                    streamInfo.LastSeenAt = Date.now();
                    // Note: do NOT set streamInfo.LastPlayerReload here. It was previously
                    // set unconditionally on new stream session creation, which made the
                    // reload-timing checks treat the session-creation timestamp as a recent
                    // reload, even though no reload had actually occurred.
                    return replaceServerTimeInM3u8(
                        (streamInfo.CodecSwap !== 'native' && streamInfo.ModifiedM3U8) || streamInfo.EncodingsM3U8,
                        serverTime,
                    );
                });
            }
        }
        // biome-ignore lint/suspicious/noExplicitAny: forwards the caller's arguments untouched (the real fetch has overloads)
        return realFetch.apply(this, arguments as any);
    };
    return installHook(self, 'fetch', hook, 'worker fetch');
}
