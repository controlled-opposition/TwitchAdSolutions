import type { AdBreak, StreamInfo } from '../shared/types.ts';
import { state } from './state.ts';

export function hasAdTags(textStr: string): boolean {
    return state.AdSignifiers.some((s) => s && textStr.includes(s));
}
export function getMatchedAdSignifiers(textStr: string): string[] {
    return state.AdSignifiers.filter((s) => textStr.includes(s));
}
function matchesAdUrlPattern(url: string): boolean {
    return state.AdSegmentURLPatterns.some((p) => url.includes(p));
}
function isKnownAdUrl(url: string): boolean {
    return !!url && (state.AdSegmentCache.has(url) || matchesAdUrlPattern(url));
}
// LL-HLS prefetch/preload hints, which let the player fetch upcoming segments early.
function isLowLatencyHint(line: string): boolean {
    return line.startsWith('#EXT-X-TWITCH-PREFETCH:') || line.startsWith('#EXT-X-PRELOAD-HINT:');
}
export function stripAdSegments(
    textStr: string,
    stripAllSegments: boolean,
    streamInfo: StreamInfo,
    brk: AdBreak,
): string {
    let hasStrippedAdSegments = false;
    let inCueOut = false;
    const liveSegments = [];
    const lines = textStr.split(/\r?\n/);
    const newAdUrl = 'https://twitch.tv';
    if (!brk.LoggedAdAttributes) {
        const adAttrs = textStr.match(/X-TV-TWITCH-AD[A-Z-]*(?==")/g);
        if (adAttrs && adAttrs.length > 0) {
            brk.LoggedAdAttributes = true;
            console.log('[AD DEBUG] Ad tracking attributes seen: ' + [...new Set(adAttrs)].join(', '));
        }
    }
    if (!brk.LoggedUnknownSignifiers) {
        const candidates = new Set<string>();
        for (const sm of textStr.matchAll(/EXT-X-DATERANGE:[^\n]*CLASS="(twitch-[^"]+)"/g)) {
            candidates.add('EXT-X-DATERANGE:CLASS="' + sm[1] + '"');
        }
        for (const sm of textStr.matchAll(/(SCTE35-[A-Z-]+|EXT-X-CUE-[A-Z-]+)/g)) {
            candidates.add(sm[1]);
        }
        const unknown = [...candidates].filter(
            (c) =>
                !state.AdSignifiers.some((s) => s && c.includes(s)) &&
                !state.KnownNonAdSignifiers.some((s) => s && c.includes(s)),
        );
        if (unknown.length > 0) {
            brk.LoggedUnknownSignifiers = true;
            console.log(
                '[AD DEBUG] Potential ad markers seen but not in AdSignifiers: ' +
                    unknown.join(', ') +
                    ' (candidates for future inclusion)',
            );
        }
    }
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('EXT-X-CUE-OUT')) {
            if (!inCueOut) {
                console.log('[AD DEBUG] SCTE-35 CUE-OUT — ad boundary entered');
            }
            inCueOut = true;
        } else if (line.includes('EXT-X-CUE-IN')) {
            if (inCueOut) {
                console.log('[AD DEBUG] SCTE-35 CUE-IN — ad boundary exited');
            }
            inCueOut = false;
        }
        // Remove tracking urls which appear in the overlay UI
        if (line.includes('X-TV-TWITCH-AD')) {
            lines[i] = line.replaceAll(state.TwitchAdUrlRewriteRegex, `$1${newAdUrl}$2`);
        }
        if (i < lines.length - 1 && line.startsWith('#EXTINF')) {
            const segmentUrl = lines[i + 1];
            const isLiveSegment = line.includes(',live');
            if (!isLiveSegment || stripAllSegments || state.AllSegmentsAreAdSegments || inCueOut) {
                if (!state.AdSegmentCache.has(segmentUrl)) {
                    brk.StrippedSegments++;
                }
                state.AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            } else if (matchesAdUrlPattern(segmentUrl)) {
                console.log('[AD DEBUG] Ad segment detected via URL pattern: ' + segmentUrl);
                state.AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
                brk.StrippedSegments++;
            } else {
                liveSegments.push({ extinf: line, url: segmentUrl });
            }
        } else if (line.startsWith('#EXT-X-PART:')) {
            // LL-HLS part: the URI is an inline attribute, and the player can fetch ad media through it.
            const partUriMatch = line.match(state.UriAttributeRegex);
            const partUri = partUriMatch ? partUriMatch[1] : '';
            if (isKnownAdUrl(partUri)) {
                state.AdSegmentCache.set(partUri, Date.now());
                lines[i] = '';
                hasStrippedAdSegments = true;
            }
        } else if (isLowLatencyHint(line)) {
            // LL-HLS hints can point at upcoming ad segments before any EXTINF or ad signifier shows,
            // so the first poll of a break could prefetch ad media. Formats:
            //   '#EXT-X-TWITCH-PREFETCH:https://url/here.ts'
            //   '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="url"'
            let hintUrl = '';
            if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                hintUrl = line.substring('#EXT-X-TWITCH-PREFETCH:'.length).trim();
            } else {
                const hintMatch = line.match(state.UriAttributeRegex);
                hintUrl = hintMatch ? hintMatch[1] : '';
            }
            if (isKnownAdUrl(hintUrl)) {
                state.AdSegmentCache.set(hintUrl, Date.now());
                hasStrippedAdSegments = true;
            }
        }
    }
    if (!hasStrippedAdSegments && hasAdTags(textStr)) {
        hasStrippedAdSegments = true;
    }
    if (hasStrippedAdSegments) {
        for (let i = 0; i < lines.length; i++) {
            // No low latency during ads (otherwise it's possible for the player to prefetch and display ad segments)
            if (isLowLatencyHint(lines[i])) {
                lines[i] = '';
            }
        }
    }
    // Recovery segments carry the MEDIA-SEQUENCE of the oldest cached one, so the player accepts them
    // at the right position in the stream.
    if (liveSegments.length > 0) {
        brk.RecoverySegments = liveSegments.slice(-6);
        const seq = parseInt((textStr.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1], 10);
        if (!Number.isNaN(seq)) {
            brk.RecoveryStartSeq = seq + Math.max(0, liveSegments.length - brk.RecoverySegments.length);
        }
    }
    if (hasStrippedAdSegments && liveSegments.length === 0) {
        brk.ConsecutiveAllStrippedPolls++;
        brk.TotalAllStrippedPolls++;
        if (!brk.FreezeStartedAt) brk.FreezeStartedAt = Date.now();
        const snapshotAge = streamInfo.LastCleanNativePlaylistAt
            ? Date.now() - streamInfo.LastCleanNativePlaylistAt
            : Infinity;
        const recentReloadReentry = streamInfo.LastPlayerReload && Date.now() - streamInfo.LastPlayerReload < 8000;
        if (
            streamInfo.LastCleanNativeM3U8 &&
            snapshotAge <= 1500 &&
            !recentReloadReentry &&
            !hasAdTags(streamInfo.LastCleanNativeM3U8)
        ) {
            console.log(
                '[AD DEBUG] All segments stripped — reusing last clean native playlist (' + snapshotAge + 'ms old)',
            );
            brk.IsStripping = hasStrippedAdSegments;
            return streamInfo.LastCleanNativeM3U8;
        }
        if (brk.RecoverySegments.length > 0) {
            console.log(
                '[AD DEBUG] All segments stripped — restoring ' + brk.RecoverySegments.length + ' recovery segments',
            );
            if (brk.RecoveryStartSeq !== undefined) {
                for (let j = 0; j < lines.length; j++) {
                    if (lines[j].startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                        lines[j] = '#EXT-X-MEDIA-SEQUENCE:' + brk.RecoveryStartSeq;
                        break;
                    }
                }
            }
            for (let j = 0; j < brk.RecoverySegments.length; j++) {
                lines.push(brk.RecoverySegments[j].extinf);
                lines.push(brk.RecoverySegments[j].url);
            }
        }
    } else if (liveSegments.length > 0) {
        brk.ConsecutiveAllStrippedPolls = 0;
    }
    brk.IsStripping = hasStrippedAdSegments;
    const now = Date.now();
    // LL-HLS can poll several times a second; prune at most once per 60s.
    if (!streamInfo.LastAdCachePruneAt || now - streamInfo.LastAdCachePruneAt > 60000) {
        streamInfo.LastAdCachePruneAt = now;
        state.AdSegmentCache.forEach((value, key, map) => {
            if (value < now - 120000) {
                map.delete(key);
            }
        });
        // Map iterates in insertion order, so this evicts the oldest.
        if (state.AdSegmentCache.size > 1000) {
            let evicted = 0;
            for (const url of state.AdSegmentCache.keys()) {
                state.AdSegmentCache.delete(url);
                if (++evicted >= 200) break;
            }
            if (!streamInfo.LoggedAdCacheSize1k) {
                streamInfo.LoggedAdCacheSize1k = true;
                console.log(
                    '[AD DEBUG] AdSegmentCache exceeded 1000 entries — evicted oldest ' +
                        evicted +
                        ' (now ' +
                        state.AdSegmentCache.size +
                        ')',
                );
            }
        }
    }
    return lines.join('\n');
}
