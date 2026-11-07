import type { StreamInfo } from '../shared/types.ts';
import { state } from './state.ts';

export function hasAdTags(textStr: string): boolean {
    return state.AdSignifiers.some((s) => s && textStr.includes(s));
}
export function getMatchedAdSignifiers(textStr: string): string[] {
    return state.AdSignifiers.filter((s) => textStr.includes(s));
}
// Remove ad segments from an m3u8 playlist and cache their URLs for replacement
export function stripAdSegments(textStr: string, stripAllSegments: boolean, streamInfo: StreamInfo): string {
    let hasStrippedAdSegments = false;
    let inCueOut = false;
    const liveSegments = [];
    const lines = textStr.split(/\r?\n/);
    const newAdUrl = 'https://twitch.tv';
    // Log ad tracking attribute names once per stream (helps identify new beacons)
    if (!streamInfo.HasLoggedAdAttributes) {
        const adAttrs = textStr.match(/X-TV-TWITCH-AD[A-Z-]*(?==")/g);
        if (adAttrs && adAttrs.length > 0) {
            streamInfo.HasLoggedAdAttributes = true;
            console.log('[AD DEBUG] Ad tracking attributes seen: ' + [...new Set(adAttrs)].join(', '));
        }
    }
    // Log potential ad markers that aren't in AdSignifiers (candidates for future inclusion)
    if (!streamInfo.HasLoggedUnknownSignifiers) {
        const candidates = new Set<string>();
        for (const sm of textStr.matchAll(/EXT-X-DATERANGE:[^\n]*CLASS="(twitch-[^"]+)"/g)) {
            candidates.add('EXT-X-DATERANGE:CLASS="' + sm[1] + '"');
        }
        for (const sm of textStr.matchAll(/(SCTE35-[A-Z-]+|EXT-X-CUE-[A-Z-]+)/g)) {
            candidates.add(sm[1]);
        }
        // Substring check (not exact): a candidate is "known" if any AdSignifier
        // appears within it. This handles prefix signifiers like 'twitch-stitched'
        // covering 'EXT-X-DATERANGE:CLASS="twitch-stitched-ad"' etc.
        const unknown = [...candidates].filter(
            (c) =>
                !state.AdSignifiers.some((s) => s && c.includes(s)) &&
                !state.KnownNonAdSignifiers.some((s) => s && c.includes(s)),
        );
        if (unknown.length > 0) {
            streamInfo.HasLoggedUnknownSignifiers = true;
            console.log(
                '[AD DEBUG] Potential ad markers seen but not in AdSignifiers: ' +
                    unknown.join(', ') +
                    ' (candidates for future inclusion)',
            );
        }
    }
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Track SCTE-35 CUE-OUT/CUE-IN ad boundaries
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
        lines[i] = line.replaceAll(state.TwitchAdUrlRewriteRegex, `$1${newAdUrl}$2`);
        const isLiveSegment = line.includes(',live');
        if (
            i < lines.length - 1 &&
            line.startsWith('#EXTINF') &&
            (!isLiveSegment || stripAllSegments || state.AllSegmentsAreAdSegments || inCueOut)
        ) {
            const segmentUrl = lines[i + 1];
            if (!state.AdSegmentCache.has(segmentUrl)) {
                streamInfo.NumStrippedAdSegments++;
            }
            state.AdSegmentCache.set(segmentUrl, Date.now());
            hasStrippedAdSegments = true;
        } else if (
            i < lines.length - 1 &&
            line.startsWith('#EXTINF') &&
            state.AdSegmentURLPatterns.some((p) => lines[i + 1].includes(p))
        ) {
            console.log('[AD DEBUG] Ad segment detected via URL pattern: ' + lines[i + 1]);
            state.AdSegmentCache.set(lines[i + 1], Date.now());
            hasStrippedAdSegments = true;
            streamInfo.NumStrippedAdSegments++;
        } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && isLiveSegment) {
            liveSegments.push({ extinf: line, url: lines[i + 1] });
        } else if (line.startsWith('#EXT-X-PART:')) {
            // LL-HLS part: URI is inline as an attribute. Strip if it matches a known
            // ad URL (already in cache from a parallel EXTINF strip, or matches a URL pattern).
            // Without this, the player may use the parts path to fetch ad media via low-latency.
            const partUriMatch = line.match(state.UriAttributeRegex);
            const partUri = partUriMatch ? partUriMatch[1] : '';
            if (
                partUri &&
                (state.AdSegmentCache.has(partUri) || state.AdSegmentURLPatterns.some((p) => partUri.includes(p)))
            ) {
                state.AdSegmentCache.set(partUri, Date.now());
                lines[i] = '';
                hasStrippedAdSegments = true;
            }
        } else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:') || line.startsWith('#EXT-X-PRELOAD-HINT:')) {
            // LL-HLS prefetch/preload hints can point at upcoming ad segments before any
            // EXTINF line or ad signifier has materialized in the playlist. If we only
            // strip prefetch hints AFTER hasStrippedAdSegments is set, the first poll of
            // an ad break can leak a prefetch hint pointing at an ad URL — the player
            // then pre-fetches ad media via the LL-HLS path before our usual strip catches
            // up, producing an ad flash. Detect the ad URL here so hasStrippedAdSegments
            // flips on the first poll and the post-loop unconditional prefetch strip fires.
            // Ported from TTV-AB 52b41b4.
            // Format: '#EXT-X-TWITCH-PREFETCH:https://url/here.ts' (raw URL after the colon)
            //     or: '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="url"' (URI attribute)
            let hintUrl = '';
            if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                hintUrl = line.substring('#EXT-X-TWITCH-PREFETCH:'.length).trim();
            } else {
                const hintMatch = line.match(/URI="([^"]+)"/);
                hintUrl = hintMatch ? hintMatch[1] : '';
            }
            if (
                hintUrl &&
                (state.AdSegmentCache.has(hintUrl) || state.AdSegmentURLPatterns.some((p) => hintUrl.includes(p)))
            ) {
                state.AdSegmentCache.set(hintUrl, Date.now());
                hasStrippedAdSegments = true;
            }
        }
    }
    // Moved out of the per-line loop: a per-line scan for any signifier is
    // semantically equivalent to a single full-text scan, since the check has
    // no line-level state — it just flips hasStrippedAdSegments = true on first
    // match. One scan instead of N_lines * N_signifiers scans (~100x fewer
    // includes() calls on a typical 100-line m3u8).
    if (!hasStrippedAdSegments && hasAdTags(textStr)) {
        hasStrippedAdSegments = true;
    }
    if (hasStrippedAdSegments) {
        for (let i = 0; i < lines.length; i++) {
            // No low latency during ads (otherwise it's possible for the player to prefetch and display ad segments)
            if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:') || lines[i].startsWith('#EXT-X-PRELOAD-HINT:')) {
                lines[i] = '';
            }
        }
    } else {
        streamInfo.NumStrippedAdSegments = 0;
    }
    // Cache live segments for recovery (plus the MEDIA-SEQUENCE of the oldest cached segment,
    // so the player accepts injected recovery segments as the correct position in the stream)
    if (liveSegments.length > 0) {
        streamInfo.RecoverySegments = liveSegments.slice(-6);
        const seq = parseInt((textStr.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1], 10);
        if (!Number.isNaN(seq)) {
            streamInfo.RecoveryStartSeq = seq + Math.max(0, liveSegments.length - streamInfo.RecoverySegments.length);
        }
    }
    // If all segments were stripped, try to prevent black screen via recovery content.
    // Prefer the full-playlist snapshot from a recent non-ad poll (mirrors TTV-AB
    // LastCleanNativeM3U8 approach) — gives the player 4-6 live segments worth of
    // content vs the thin per-segment recovery cache. Falls back to the per-segment
    // cache if the snapshot is stale or missing.
    if (hasStrippedAdSegments && liveSegments.length === 0) {
        streamInfo.ConsecutiveAllStrippedPolls = (streamInfo.ConsecutiveAllStrippedPolls || 0) + 1;
        streamInfo.TotalAllStrippedPolls = (streamInfo.TotalAllStrippedPolls || 0) + 1;
        if (!streamInfo.FreezeStartedAt) streamInfo.FreezeStartedAt = Date.now();
        // Primary: fresh full-playlist snapshot (< 1.5s old, must not itself contain ad markers)
        const snapshotAge = streamInfo.LastCleanNativePlaylistAt
            ? Date.now() - streamInfo.LastCleanNativePlaylistAt
            : Infinity;
        // Post-ad re-entry guard (mirrors TTV-AB v9.1.3): on a consecutive break that re-enters
        // within the 8s post-ad reload window, the snapshot can straddle the end-of-break reload
        // boundary and replay stale content from the previous cycle. Skip it and fall through to
        // the per-segment recovery cache, which is rebuilt from the current break's polls.
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
            streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
            return streamInfo.LastCleanNativeM3U8;
        }
        // Fallback: per-segment recovery cache (existing behavior)
        if (streamInfo.RecoverySegments && streamInfo.RecoverySegments.length > 0) {
            console.log(
                '[AD DEBUG] All segments stripped — restoring ' +
                    streamInfo.RecoverySegments.length +
                    ' recovery segments',
            );
            if (streamInfo.RecoveryStartSeq !== undefined) {
                for (let j = 0; j < lines.length; j++) {
                    if (lines[j].startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                        lines[j] = '#EXT-X-MEDIA-SEQUENCE:' + streamInfo.RecoveryStartSeq;
                        break;
                    }
                }
            }
            for (let j = 0; j < streamInfo.RecoverySegments.length; j++) {
                lines.push(streamInfo.RecoverySegments[j].extinf);
                lines.push(streamInfo.RecoverySegments[j].url);
            }
        }
    } else if (liveSegments.length > 0) {
        // Reset freeze counter when live segments are available
        streamInfo.ConsecutiveAllStrippedPolls = 0;
    }
    streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
    const now = Date.now();
    // Throttle cache prune to once per 60s. The 120s TTL gives plenty of headroom
    // and scanning the full cache on every m3u8 poll adds up during heavy ad break
    // sequences (LL-HLS can poll multiple times per second). Ported from TTV-AB.
    if (!streamInfo.LastAdCachePruneAt || now - streamInfo.LastAdCachePruneAt > 60000) {
        streamInfo.LastAdCachePruneAt = now;
        state.AdSegmentCache.forEach((value, key, map) => {
            if (value < now - 120000) {
                map.delete(key);
            }
        });
        // Bound the cache to prevent unbounded growth on long sessions. Each entry is
        // a URL string + Date.now() timestamp (~200-300 bytes); over a multi-hour session
        // with frequent ad breaks, the Map can reach MB-scale. When size > 1000, evict
        // the oldest 200 entries (Map iteration order is insertion order, so FIFO).
        // Old ad URLs are unlikely to be requested again; if they are, they'll be
        // re-cached via the strip path normally.
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
