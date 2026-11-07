import type { ResolutionInfo, StreamInfo } from '../shared/types.ts';
import { processM3U8 } from './m3u8.ts';
import { getServerTimeFromM3u8, parseAttributes, replaceServerTimeInM3u8, videoCodecFamily } from './playlist.ts';
import { createStreamInfo } from './stream-info.ts';
import { state } from './state.ts';

// Hook fetch() in the worker scope to intercept m3u8 playlist requests and ad segments
export function hookWorkerFetch() {
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
    self.fetch = async function (this: unknown, url, options) {
        if (typeof url === 'string') {
            if (state.AdSegmentCache.has(url)) {
                return new Response(BLANK_MP4);
            }
            url = url.trimEnd();
            if (url.endsWith('m3u8')) {
                return new Promise(function (resolve, reject) {
                    const processAfter = async function (response: Response) {
                        if (response.status === 200) {
                            resolve(new Response(await processM3U8(url as string, await response.text(), realFetch)));
                        } else {
                            resolve(response);
                        }
                    };
                    realFetch(url, options)
                        .then(function (response) {
                            processAfter(response);
                        })
                        ['catch'](function (err) {
                            reject(err);
                        });
                });
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
                return new Promise(function (resolve, reject) {
                    const processAfter = async function (response: Response) {
                        if (response.status === 200) {
                            const encodingsM3u8 = await response.text();
                            const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                            let streamInfo: StreamInfo | null = state.StreamInfos[channelName];
                            if (streamInfo != null && streamInfo.EncodingsM3U8 != null) {
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
                            if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                // Clear reload-pending flag from a prior stream session — without this,
                                // a reload triggered on the previous channel bleeds into the new channel's
                                // cooldown calculation, blocking legitimate end-of-break reloads.
                                state.HasTriggeredPlayerReload = false;
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
                                const lines = encodingsM3u8.split(/\r?\n/);
                                for (let i = 0; i < lines.length - 1; i++) {
                                    if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                        const attributes = parseAttributes(lines[i]);
                                        const resolution = attributes['RESOLUTION'];
                                        if (resolution) {
                                            const resolutionInfo = {
                                                Resolution: resolution,
                                                FrameRate: attributes['FRAME-RATE'],
                                                // || '' like the three below: CODECS is optional on a STREAM-INF line,
                                                // and this entry is pushed whenever RESOLUTION is present. Leaving it
                                                // undefined is what let a direct .startsWith() reader throw and hang the
                                                // master-playlist fetch. Keep every field in this object string-valued.
                                                Codecs: attributes['CODECS'] || '',
                                                // AUDIO/VIDEO/SUBTITLES groups are copied onto the rewritten STREAM-INF
                                                // line during HEVC→AVC fallback so the variant references matching media
                                                // groups (mirrors TTV-AB v6.7.5 parser fix). Without these, the rewritten
                                                // line keeps the original HEVC variant's group ids, which point at audio
                                                // tracks the AVC backup may not carry — black screen / audio desync.
                                                Audio: attributes['AUDIO'] || '',
                                                Video: attributes['VIDEO'] || '',
                                                Subtitles: attributes['SUBTITLES'] || '',
                                                Url: lines[i + 1],
                                            };
                                            streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                            streamInfo.ResolutionList.push(resolutionInfo);
                                        }
                                        state.StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                    }
                                }
                                if (streamInfo.ResolutionList.length === 0) {
                                    console.log(
                                        '[AD DEBUG] No resolutions parsed from encodings m3u8 — Twitch may have changed the format',
                                    );
                                }
                                // Codec-safe swap-target pool = AVC (H.264) only. Mirrors TTV-AB v12.0.9 /
                                // parser.ts _isEnhancedCodecString: AV1 ('av0*') is an "enhanced" codec that can go
                                // BLACK for the whole ad break on some browsers/hardware (GosuDRM/TTV-AB #47), exactly
                                // like HEVC — so AV1 must NOT be a swap target. If a stream has no AVC at all
                                // (enhanced-only), this list is empty and the swap below simply doesn't fire — we leave
                                // the stream untouched, matching TTV-AB's all-enhanced short-circuit.
                                const decodableResolutionList = streamInfo.ResolutionList.filter(
                                    (element: ResolutionInfo) => videoCodecFamily(element.Codecs) === 'avc',
                                );
                                // Fire when ANY enhanced variant (HEVC or AV1) is present and we have a decodable (AVC)
                                // target. Adding av0 here fixes native-AV1 streams that previously never triggered a
                                // swap and played AV1 straight into the ad-break black screen.
                                if (
                                    state.AlwaysReloadPlayerOnAd ||
                                    (decodableResolutionList.length > 0 &&
                                        streamInfo.ResolutionList.some((element: ResolutionInfo) => {
                                            const f = videoCodecFamily(element.Codecs);
                                            return f === 'hevc' || f === 'av1';
                                        }) &&
                                        !state.SkipPlayerReloadOnHevc)
                                ) {
                                    // Replace OR append a STREAM-INF attribute (replace if present, append after a comma if absent).
                                    // Used below to copy AUDIO/VIDEO/SUBTITLES groups from the closest non-HEVC variant onto the
                                    // rewritten HEVC line, matching TTV-AB v6.7.5's parser fix.
                                    const replaceOrAppendStreamInfAttr: (
                                        line: string,
                                        key: string,
                                        value: unknown,
                                    ) => string = (line, key, value) => {
                                        if (typeof value !== 'string' || !value) return line;
                                        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                                        const next = key + '="' + escaped + '"';
                                        const pattern = new RegExp('(^|,)' + key + '=("[^"]*"|[^,]*)');
                                        return pattern.test(line)
                                            ? line.replace(pattern, '$1' + next)
                                            : line + ',' + next;
                                    };
                                    if (decodableResolutionList.length > 0) {
                                        for (let i = 0; i < lines.length - 1; i++) {
                                            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                                const resSettings = parseAttributes(
                                                    lines[i].substring(lines[i].indexOf(':') + 1),
                                                );
                                                const codecsKey = 'CODECS';
                                                const lineFamily = videoCodecFamily(resSettings[codecsKey]);
                                                if (lineFamily === 'hevc' || lineFamily === 'av1') {
                                                    const oldResolution = resSettings['RESOLUTION'];
                                                    const [targetWidth, targetHeight] = oldResolution
                                                        .split('x')
                                                        .map(Number);
                                                    const targetArea = targetWidth * targetHeight;
                                                    let newResolutionInfo = null;
                                                    let closestDiff = Infinity;
                                                    for (let j = 0; j < decodableResolutionList.length; j++) {
                                                        const candidate = decodableResolutionList[j];
                                                        const [streamWidth, streamHeight] =
                                                            candidate.Resolution.split('x').map(Number);
                                                        const diff = Math.abs(streamWidth * streamHeight - targetArea);
                                                        if (diff < closestDiff) {
                                                            closestDiff = diff;
                                                            newResolutionInfo = candidate;
                                                        }
                                                    }
                                                    if (!newResolutionInfo) continue; // unreachable: decodableResolutionList is non-empty here
                                                    console.log(
                                                        'ModifiedM3U8 swap ' +
                                                            resSettings[codecsKey] +
                                                            ' to ' +
                                                            newResolutionInfo.Codecs +
                                                            ' oldRes:' +
                                                            oldResolution +
                                                            ' newRes:' +
                                                            newResolutionInfo.Resolution,
                                                    );
                                                    lines[i] = lines[i].replace(
                                                        /CODECS="[^"]+"/,
                                                        `CODECS="${newResolutionInfo.Codecs}"`,
                                                    );
                                                    // Copy media-group attributes from the closest non-HEVC variant so the
                                                    // rewritten line references audio/video/subtitle tracks the AVC backup
                                                    // actually carries. TTV-AB v6.7.5 parser fix.
                                                    lines[i] = replaceOrAppendStreamInfAttr(
                                                        lines[i],
                                                        'AUDIO',
                                                        newResolutionInfo.Audio,
                                                    );
                                                    lines[i] = replaceOrAppendStreamInfAttr(
                                                        lines[i],
                                                        'VIDEO',
                                                        newResolutionInfo.Video,
                                                    );
                                                    lines[i] = replaceOrAppendStreamInfAttr(
                                                        lines[i],
                                                        'SUBTITLES',
                                                        newResolutionInfo.Subtitles,
                                                    );
                                                    lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1); // The stream doesn't load unless each url line is unique
                                                }
                                            }
                                        }
                                    }
                                    if (decodableResolutionList.length > 0 || state.AlwaysReloadPlayerOnAd) {
                                        streamInfo.ModifiedM3U8 = lines.join('\n');
                                    }
                                }
                            }
                            streamInfo.LastSeenAt = Date.now();
                            // Note: do NOT set streamInfo.LastPlayerReload here. It was previously
                            // set unconditionally on new stream session creation, which caused the
                            // first end-of-break reload of every new channel to be blocked by
                            // cooldown — the cooldown check treated the session-creation timestamp
                            // as a recent reload, even though no reload had actually occurred.
                            resolve(
                                new Response(
                                    replaceServerTimeInM3u8(
                                        (streamInfo.IsUsingModifiedM3U8 && streamInfo.ModifiedM3U8) ||
                                            streamInfo.EncodingsM3U8,
                                        serverTime,
                                    ),
                                ),
                            );
                        } else {
                            resolve(response);
                        }
                    };
                    realFetch(url, options)
                        .then(function (response) {
                            processAfter(response);
                        })
                        ['catch'](function (err) {
                            reject(err);
                        });
                });
            }
        }
        // biome-ignore lint/suspicious/noExplicitAny: forwards the caller's arguments untouched (the real fetch has overloads)
        return realFetch.apply(this, arguments as any);
    };
}
