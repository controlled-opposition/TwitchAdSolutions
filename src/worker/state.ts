// Worker-side settings and state. One instance per injected worker (each worker runs its own
// copy of the worker bundle).
import { defaultSharedConfig } from '../shared/config.ts';
import type { PlayerType, StreamInfo } from '../shared/types.ts';

export function createWorkerState() {
    return {
        ...defaultSharedConfig(),
        // 'twitch-stitched' catches the twitch-stitched-* DATERANGE class family
        // (-ad, -mid, -pod, etc.) without requiring an exact -ad suffix. Twitch-
        // prefixed so we don't re-introduce the PR #120 false-positive from bare
        // 'stitched' substring match. The specific twitch-stitched-ad DATERANGE
        // marker is a subset of this prefix.
        /** Substrings that mark an m3u8 as carrying ads. */
        AdSignifiers: [
            'stitched-ad',
            'EXT-X-CUE-OUT',
            'twitch-stitched',
            'EXT-X-DATERANGE:CLASS="twitch-maf-ad"',
            'EXT-X-DATERANGE:CLASS="twitch-trigger"',
        ],
        // DATERANGE classes confirmed as session/source metadata over weeks of field
        // observation — surface as "candidates" otherwise. Filtered out by the candidate
        // logger so the diagnostic stays focused on genuinely new markers.
        KnownNonAdSignifiers: ['twitch-session', 'twitch-stream-source', 'twitch-ad-quartile', 'twitch-assignment'],
        /** Segment URL substrings that identify ad segments. */
        AdSegmentURLPatterns: ['/adsquared/', '/_404/', '/processing'],
        // Precompiled regexes shared across the stripAdSegments hot path, so literals
        // inside the per-line strip loop don't recompile on every iteration — for
        // a 100-line m3u8 at ~2 polls/sec during an ad break, hoisting the URL
        // rewrite alone saves ~200 regex compilations per second.
        TwitchAdUrlRewriteRegex: /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g,
        UriAttributeRegex: /URI="([^"]+)"/,
        ClientID: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        /** Player types tried, in order, when searching for an ad-free backup stream. */
        BackupPlayerTypes: [
            // Order matters: first clean type wins. 'embed' moved to end — field-observed
            // Twitch returns GQL 'server error' for streamPlaybackAccessToken on embed when
            // requested from twitch.tv origin, wasting ~200-400ms per break as first-try.
            // Kept in case it ever succeeds on some channel/user combo.
            'site', //Source
            'popout', //Source
            'mobile_web', //Mobile
            'embed', //Source (unreliable — see note above)
            // 'autoplay' (360p) removed: when committed as cycle backup, the player gets stuck
            // in an endless loading circle after the CSAI-only path releases the backup —
            // autoplay variants don't transition cleanly back to main stream variants.
        ] as PlayerType[],
        FallbackPlayerType: 'site' as PlayerType, // was 'embed' — site is more reliable when all Source types end up ad-laden
        SkipPlayerReloadOnHevc: false, // If true this will skip player reload on streams which have 2k/4k quality (if you enable this and you use the 2k/4k quality setting you'll get error #4000 / #3000 / spinning wheel on chrome based browsers). Despite the name, gates BOTH enhanced families (HEVC and AV1) since v68.5.3.
        AlwaysReloadPlayerOnAd: false, // Always pause/play when entering/leaving ads
        PlayerReloadMinimalRequestsTime: 1500,
        PlayerReloadMinimalRequestsPlayerIndex: 2, //autoplay
        HasTriggeredPlayerReload: false,
        /** Channel name -> stream state. */
        StreamInfos: Object.create(null) as Record<string, StreamInfo>,
        /** Variant playlist URL -> owning stream state. */
        StreamInfosByUrl: Object.create(null) as Record<string, StreamInfo>,
        SimulatedAdsDepth: 0,
        V2API: false,
        IsAdStrippingEnabled: true,
        /** Ad segment URL -> time it was cached (ms). The worker fetch hook answers these with a blank MP4. */
        AdSegmentCache: new Map<string, number>(),
        AllSegmentsAreAdSegments: false,
        StreamInfoMaxAgeMs: 30 * 60 * 1000,
    };
}

export const state = createWorkerState();
