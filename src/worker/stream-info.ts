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
    for (const url in state.StreamInfosByUrl) {
        const streamInfo = state.StreamInfosByUrl[url];
        if (state.StreamInfos[streamInfo.ChannelName] !== streamInfo) {
            delete state.StreamInfosByUrl[url];
        }
    }
}
export function createStreamInfo(channelName: string, encodingsM3u8: string, usherParams: string): StreamInfo {
    return {
        ChannelName: channelName,
        LastSeenAt: Date.now(),
        EncodingsM3U8: encodingsM3u8,
        UsherParams: usherParams,
        Urls: Object.create(null),
        ModifiedM3U8: null,
        CodecSwap: 'native',
        Break: null,
        ConsecutiveZeroStripBreaks: 0,
        LastAdCachePruneAt: 0,
        LastCleanNativeM3U8: null,
        LastCleanNativePlaylistAt: 0,
        BackupEncodingsM3U8Cache: Object.create(null),
        PinnedBackupPlayerType: null,
        SourceTierExhausted: false,
        FastAutoplayWins: 0,
        LastPlayerReload: 0,
        ReloadPending: false,
        HasCheckedUnknownTags: false,
        LoggedOfflineTransition: false,
        ConsecutiveTokenFetchFailures: 0,
        LoggedTokenFailureStreak: false,
        LoggedAdCacheSize1k: false,
    };
}
