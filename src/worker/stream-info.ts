import type { StreamInfo } from '../shared/types.ts';
import { state } from './state.ts';

export function pruneStreamInfos() {
    const now = Date.now();
    for (const channelName in state.StreamInfos) {
        const streamInfo = state.StreamInfos[channelName];
        if (!streamInfo || !streamInfo.LastSeenAt || now - streamInfo.LastSeenAt > state.StreamInfoMaxAgeMs) {
            if (streamInfo && streamInfo.Urls) {
                for (const url in streamInfo.Urls) {
                    delete state.StreamInfosByUrl[url];
                }
            }
            delete state.StreamInfos[channelName];
        }
    }
    // A stream restart replaces the channel's StreamInfo, and the old one's variant URLs stay in
    // StreamInfosByUrl (the loop above only reaches the current one's). Drop every entry that no
    // longer points at its channel's live StreamInfo, so replaced ones can be collected.
    for (const url in state.StreamInfosByUrl) {
        const streamInfo = state.StreamInfosByUrl[url];
        if (state.StreamInfos[streamInfo.ChannelName] !== streamInfo) {
            delete state.StreamInfosByUrl[url];
        }
    }
}
// Creates a new StreamInfo with the full field shape declared up-front.
// When adding a new streamInfo field, declare it here with an appropriate
// zero value so the complete shape is visible in one place. Per-break state lives in
// AdBreak (createAdBreak() in ad-break.ts), not here.
export function createStreamInfo(channelName: string, encodingsM3u8: string, usherParams: string): StreamInfo {
    return {
        // Identity / lifecycle
        ChannelName: channelName,
        LastSeenAt: Date.now(),
        EncodingsM3U8: encodingsM3u8,
        UsherParams: usherParams,
        // Resolutions / URL map
        Urls: Object.create(null), // xxx.m3u8 -> { Resolution: "284x160", FrameRate: 30.0 }
        ResolutionList: [],
        // Codec swap
        ModifiedM3U8: null,
        CodecSwap: 'native',
        Break: null,
        ConsecutiveZeroStripBreaks: 0,
        LastAdCachePruneAt: 0, // stripAdSegments: last AdSegmentCache prune (throttled to once per 60s)
        // Clean playlist snapshot for all-stripped recovery (mirrors TTV-AB)
        LastCleanNativeM3U8: null,
        LastCleanNativePlaylistAt: 0,
        // Backup player types, across breaks
        BackupEncodingsM3U8Cache: Object.create(null), // player type -> encodings m3u8 (null once used)
        PinnedBackupPlayerType: null,
        SourceTierExhausted: false,
        FastAutoplayWins: 0,
        // Last player reload (post-ad re-entry guards, minimal-request window)
        LastPlayerReload: 0,
        ReloadPending: false, // the page reloaded; the next poll stamps LastPlayerReload
        // Diagnostics
        HasCheckedUnknownTags: false,
        LoggedOfflineTransition: false, // Set when the m3u8 turns offline-shaped mid-session.
        ConsecutiveTokenFetchFailures: 0, // Consecutive failed access-token fetches across player types. Logged at threshold, reset on success.
        LoggedTokenFailureStreak: false, // Once-per-streak guard for the threshold log.
        LoggedAdCacheSize1k: false,
    };
}
