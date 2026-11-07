// Types shared by the page bundle and the worker bundle.

/**
 * Twitch player types used for access tokens. Known values are listed for completeness;
 * any string from localStorage is accepted.
 */
export type PlayerType = 'site' | 'popout' | 'mobile_web' | 'embed' | 'autoplay' | (string & {});

/** Video codec family of an m3u8 CODECS attribute (see videoCodecFamily). */
export type VideoCodecFamily = 'avc' | 'hevc' | 'av1' | 'unknown';

/** One variant from the master (encodings) playlist. */
export interface ResolutionInfo {
    /** e.g. "1920x1080" */
    Resolution: string;
    FrameRate: number | string | undefined;
    Codecs: string;
    Audio: string;
    Video: string;
    Subtitles: string;
    Url: string;
}

/** A live segment kept to refill the playlist when every segment of a poll is an ad. */
export interface RecoverySegment {
    extinf: string;
    url: string;
}

/**
 * Per-channel stream state. createStreamInfo() builds the full shape; add new fields
 * there and here together.
 */
export interface StreamInfo {
    // Identity / lifecycle
    ChannelName: string;
    LastSeenAt: number;
    EncodingsM3U8: string;
    UsherParams: string;
    // Resolutions / URL map
    Urls: Record<string, ResolutionInfo>;
    ResolutionList: ResolutionInfo[];
    RequestedAds: Set<string>;
    SpoofedAdIds: Set<string>;
    // Modified m3u8 state
    ModifiedM3U8: string | null;
    IsUsingModifiedM3U8: boolean;
    // Ad-break state
    IsShowingAd: boolean;
    IsMidroll: boolean;
    AdBreakStartedAt: number;
    PodLength: number;
    HasConfirmedAdAttrs: boolean;
    CleanPlaylistCount: number;
    PendingAdEndAt: number;
    AdEndBounceCount: number;
    ConsecutiveZeroStripBreaks: number;
    CsaiOnlyThisBreak: boolean;
    // Strip state
    IsStrippingAdSegments: boolean;
    NumStrippedAdSegments: number;
    RecoverySegments: RecoverySegment[];
    /** LOAD-BEARING: checked with `!== undefined`. */
    RecoveryStartSeq: number | undefined;
    FreezeStartedAt: number;
    ConsecutiveAllStrippedPolls: number;
    TotalAllStrippedPolls: number;
    LastAdCachePruneAt: number;
    // Clean playlist snapshot for all-stripped recovery
    LastCleanNativeM3U8: string | null;
    LastCleanNativePlaylistAt: number;
    // Backup player type cycling
    /** Player type -> encodings m3u8 fetched for it this break (null once used). */
    BackupEncodingsM3U8Cache: Record<string, string | null>;
    ActiveBackupPlayerType: PlayerType | null;
    PinnedBackupPlayerType: PlayerType | null;
    LastCommittedBackupPlayerType: PlayerType | null;
    /** Player type -> failure time (ms); entries expire for retry. */
    FailedBackupPlayerTypes: Map<PlayerType, number>;
    LoggedBackupAdsByType: Set<PlayerType> | null;
    CycleRescuedThisBreak: boolean;
    // Early reload
    EarlyReloadCount: number;
    EarlyReloadAtPoll: number;
    EarlyReloadTriggered: boolean;
    EarlyReloadAwaitingResult: boolean;
    // Hybrid mode (PreferLowQualityBackup)
    EscapeHatchFired: boolean;
    LastBreakUsedEscapeHatch: boolean;
    FastAutoplayConsecutive: number;
    // Reload cooldown
    LastPlayerReload: number;
    ReloadTimestamps: number[];
    // Diagnostic flags
    HasCheckedUnknownTags: boolean;
    HasLoggedAdAttributes: boolean;
    HasLoggedUnknownSignifiers: boolean;
    LoggedOfflineTransition: boolean;
    ConsecutiveTokenFetchFailures: number;
    LoggedTokenFailureStreak: boolean;
    LoggedAdCacheSize1k: boolean;
    LoggedContamReorderThisBreak: boolean;
    LoggedFastAutoplayThisBreak: boolean;
    LoggedFastAutoplayReprobeThisBreak: boolean;
}

/** Return value of parseAttributes(): numeric-looking values become numbers. */
// biome-ignore lint/suspicious/noExplicitAny: values are strings or numbers depending on the attribute; callers know which
export type M3u8Attributes = Record<string, any>;

// ---------------------------------------------------------------------------
// Settings the page passes to the worker
// ---------------------------------------------------------------------------

/**
 * Settings the worker needs from the page: the localStorage-tunable options it reads, and the
 * GQL headers the page has captured so far. Later header changes arrive as Update* messages.
 */
export interface SharedConfig {
    ReloadPlayerAfterAd: boolean;
    ReloadCooldownSeconds: number;
    EarlyReloadPollThreshold: number;
    PinBackupPlayerType: boolean;
    PreferLowQualityBackup: boolean;
    FastAutoplayFirstTry: boolean;
    BackupSwapFirst: boolean;
    DisableAdSpoofing: boolean;
    SoftReloadNoStrip: boolean;
    /** Player type used for access-token requests (localStorage twitchAdSolutions_playerType). */
    ForceAccessTokenPlayerType: PlayerType;
    GQLDeviceID: string | null;
    AuthorizationHeader: string | undefined;
    ClientIntegrityHeader: string | null;
    ClientVersion: string | null;
    ClientSession: string | null;
}

/** What the page hands the worker bundle when it starts it (see hookWindowWorker). */
export interface WorkerInit {
    /** Twitch's own worker script, loaded and run after vaft's hooks are installed. */
    twitchBlobUrl: string;
    config: SharedConfig;
}

// ---------------------------------------------------------------------------
// Messages between the page and the worker
// ---------------------------------------------------------------------------

/** 'early' = hard reload (new media player + token); 'post-ad' = soft reload. */
export type ReloadKind = 'early' | 'post-ad';

export interface AdBlockBannerMessage {
    key: 'UpdateAdBlockBanner';
    isMidroll: boolean;
    hasAds: boolean;
    isStrippingAdSegments: boolean;
    numStrippedAdSegments?: number;
    activeBackupPlayerType?: PlayerType | null;
}

/** A GQL request the worker asks the page to make (workers can't send credentialed requests). */
export interface WorkerFetchRequest {
    id: string;
    url: string;
    options: RequestInit & { headers: Record<string, string> };
}

/** The page's answer to a WorkerFetchRequest. */
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

/** Messages posted by the worker to the page (postToPage). */
export type WorkerToPageMessage =
    | AdBlockBannerMessage
    | { key: 'PauseResumePlayer' }
    | { key: 'ReloadPlayer'; kind?: ReloadKind }
    | { key: 'FetchRequest'; value: WorkerFetchRequest };

/** Page -> worker message keys and the type of each message's `value`. */
export interface PageToWorkerValues {
    UpdateClientVersion: string;
    UpdateClientSession: string;
    UpdateClientId: string;
    UpdateDeviceId: string;
    UpdateClientIntegrityHeader: string;
    UpdateAuthorizationHeader: string;
    FetchResponse: WorkerFetchResponse;
    TriggeredPlayerReload: undefined;
    /** Main thread refused a reload because the player is healthy. */
    ReloadSkipped: undefined;
    /** Debug toggle (window.allSegmentsAreAdSegments). */
    AllSegmentsAreAdSegments: undefined;
    /** Debug: window.simulateAds(depth). */
    SimulateAds: number;
}

/** Messages posted by the page to the worker (postTwitchWorkerMessage). */
export type PageToWorkerMessage = {
    [K in keyof PageToWorkerValues]: { key: K; value: PageToWorkerValues[K] };
}[keyof PageToWorkerValues];
