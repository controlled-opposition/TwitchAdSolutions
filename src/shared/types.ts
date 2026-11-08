export type PlayerType = 'site' | 'popout' | 'mobile_web' | 'embed' | 'autoplay' | (string & {});

export type VideoCodecFamily = 'avc' | 'hevc' | 'av1' | 'unknown';

export interface ResolutionInfo {
    Resolution: string;
    FrameRate: number | string | undefined;
    Codecs: string;
    Audio: string;
    Video: string;
    Subtitles: string;
    Url: string;
}

export interface RecoverySegment {
    extinf: string;
    url: string;
}

export type EarlyReloadState =
    | { phase: 'armed' }
    | { phase: 'requested'; requestId: number; at: number }
    | { phase: 'reloaded' };

export type BreakPath = 'probing' | 'sticky-csai' | 'escaped';

export interface AdBreakEnd {
    since: number;
    cleanPolls: number;
    bounces: number;
}

export interface AdBreak {
    StartedAt: number;
    IsMidroll: boolean;
    PodLength: number;
    HasConfirmedAdAttrs: boolean;
    End: AdBreakEnd | null;
    Path: BreakPath;
    IsStripping: boolean;
    StrippedSegments: number;
    RecoverySegments: RecoverySegment[];
    RecoveryStartSeq: number | undefined;
    FreezeStartedAt: number;
    ConsecutiveAllStrippedPolls: number;
    TotalAllStrippedPolls: number;
    ActiveBackupPlayerType: PlayerType | null;
    LastCommittedBackupPlayerType: PlayerType | null;
    FailedBackupPlayerTypes: Map<PlayerType, number>;
    ContaminatedTypes: Set<PlayerType>;
    CycleRescued: boolean;
    AutoplayFirst: boolean | null;
    EarlyReload: EarlyReloadState;
    EarlyReloadCount: number;
    EarlyReloadAtPoll: number;
    CodecSwapTried: boolean;
    RequestedAds: Set<string>;
    SpoofedAdIds: Set<string>;
    LoggedAdAttributes: boolean;
    LoggedUnknownSignifiers: boolean;
    LoggedContamReorder: boolean;
    LoggedAutoplayOrder: boolean;
}

export type CodecSwapState = 'native' | 'switching' | 'swapped';

export interface StreamInfo {
    ChannelName: string;
    LastSeenAt: number;
    EncodingsM3U8: string;
    UsherParams: string;
    Urls: Record<string, ResolutionInfo>;
    ModifiedM3U8: string | null;
    CodecSwap: CodecSwapState;
    Break: AdBreak | null;
    ConsecutiveZeroStripBreaks: number;
    LastAdCachePruneAt: number;
    LastCleanNativeM3U8: string | null;
    LastCleanNativePlaylistAt: number;
    BackupEncodingsM3U8Cache: Record<string, string | null>;
    PinnedBackupPlayerType: PlayerType | null;
    SourceTierExhausted: boolean;
    FastAutoplayWins: number;
    LastPlayerReload: number;
    ReloadPending: boolean;
    HasCheckedUnknownTags: boolean;
    LoggedOfflineTransition: boolean;
    ConsecutiveTokenFetchFailures: number;
    LoggedTokenFailureStreak: boolean;
    LoggedAdCacheSize1k: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: values are strings or numbers depending on the attribute; callers know which
export type M3u8Attributes = Record<string, any>;

export interface SharedConfig {
    ReloadPlayerAfterAd: boolean;
    EarlyReloadPollThreshold: number;
    PinBackupPlayerType: boolean;
    PreferLowQualityBackup: boolean;
    FastAutoplayFirstTry: boolean;
    BackupSwapFirst: boolean;
    DisableAdSpoofing: boolean;
    SoftReloadNoStrip: boolean;
    ForceAccessTokenPlayerType: PlayerType;
    GQLDeviceID: string | null;
    AuthorizationHeader: string | undefined;
    ClientIntegrityHeader: string | null;
    ClientVersion: string | null;
    ClientSession: string | null;
}

export interface WorkerInit {
    twitchBlobUrl: string;
    config: SharedConfig;
}

export type ReloadKind = 'early' | 'post-ad' | 'codec-swap';

export type ReloadOutcome = 'reloaded' | 'skipped-healthy' | 'not-done';

export interface AdBlockBannerMessage {
    key: 'UpdateAdBlockBanner';
    isMidroll: boolean;
    hasAds: boolean;
    isStrippingAdSegments: boolean;
    numStrippedAdSegments?: number;
    activeBackupPlayerType?: PlayerType | null;
}

export interface WorkerFetchRequest {
    id: string;
    url: string;
    options: RequestInit & { headers: Record<string, string> };
}

export type WorkerFetchResponse =
    | {
          id: string;
          status: number;
          statusText: string;
          ok: boolean;
          redirected: boolean;
          type: ResponseType;
          url: string;
          headers: Record<string, string>;
          body: string;
          error?: undefined;
      }
    | { id: string; error: string };

export type WorkerToPageMessage =
    | AdBlockBannerMessage
    | { key: 'PauseResumePlayer' }
    | { key: 'ReloadPlayer'; kind: ReloadKind; requestId?: number }
    | { key: 'FetchRequest'; value: WorkerFetchRequest };

export interface PageToWorkerValues {
    UpdateClientVersion: string;
    UpdateClientSession: string;
    UpdateClientId: string;
    UpdateDeviceId: string;
    UpdateClientIntegrityHeader: string;
    UpdateAuthorizationHeader: string;
    FetchResponse: WorkerFetchResponse;
    TriggeredPlayerReload: undefined;
    ReloadResult: { requestId: number; outcome: ReloadOutcome };
    AllSegmentsAreAdSegments: undefined;
    SimulateAds: number;
}

export type PageToWorkerMessage = {
    [K in keyof PageToWorkerValues]: { key: K; value: PageToWorkerValues[K] };
}[keyof PageToWorkerValues];
