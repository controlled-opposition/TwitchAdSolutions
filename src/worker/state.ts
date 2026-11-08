import { defaultSharedConfig } from '../shared/config.ts';
import type { PlayerType, StreamInfo } from '../shared/types.ts';

function createWorkerState() {
    return {
        ...defaultSharedConfig(),
        // Twitch's twitch-stitched-* DATERANGE classes; a bare 'stitched' gave false positives (PR #120).
        AdSignifiers: [
            'stitched-ad',
            'EXT-X-CUE-OUT',
            'twitch-stitched',
            'EXT-X-DATERANGE:CLASS="twitch-maf-ad"',
            'EXT-X-DATERANGE:CLASS="twitch-trigger"',
        ],
        // Twitch DATERANGE classes seen on non-ad playlists; the unknown-marker log skips them.
        KnownNonAdSignifiers: ['twitch-session', 'twitch-stream-source', 'twitch-ad-quartile', 'twitch-assignment'],
        AdSegmentURLPatterns: ['/adsquared/', '/_404/', '/processing'],
        TwitchAdUrlRewriteRegex: /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g,
        UriAttributeRegex: /URI="([^"]+)"/,
        ClientID: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        BackupPlayerTypes: [
            // First clean type wins. Twitch's GQL answers 'server error' to embed tokens requested
            // from twitch.tv, so embed goes last.
            'site', //Source
            'popout', //Source
            'mobile_web', //Mobile
            'embed', //Source
            // Not 'autoplay': committed as a backup, the player loops a loading circle once the
            // backup is released, since autoplay variants don't transition back to the main stream's.
        ] as PlayerType[],
        FallbackPlayerType: 'site' as PlayerType, // more reliable than embed when every Source type is ad-laden
        PlayerReloadMinimalRequestsTime: 1500,
        PlayerReloadMinimalRequestsPlayerIndex: 2,
        StreamInfos: Object.create(null) as Record<string, StreamInfo>,
        StreamInfosByUrl: Object.create(null) as Record<string, StreamInfo>,
        SimulatedAdsDepth: 0,
        V2API: false,
        AdSegmentCache: new Map<string, number>(),
        AllSegmentsAreAdSegments: false,
        StreamInfoMaxAgeMs: 30 * 60 * 1000,
    };
}

export const state = createWorkerState();
