// Type declarations for vaft/vaft.user.js.
//
// vaft.user.js is a classic script, not a module, so everything here is global and visible
// to the JSDoc annotations in it. Nothing in this file is shipped; it only drives
// `tsc` (see tsconfig.json).

// ---------------------------------------------------------------------------
// Shared config/state created by declareOptions(scope).
//
// declareOptions() runs twice: declareOptions(window) on the page, and
// declareOptions(self) inside the injected worker blob. Code on both sides then uses these
// as bare globals. Keep this list in sync with declareOptions(); a name assigned there but
// missing here is an "unknown name" error at every use site.
// ---------------------------------------------------------------------------

/** Substrings that mark an m3u8 as carrying ads. */
declare var AdSignifiers: string[];
/** DATERANGE classes known to be session/source metadata, not ad markers. */
declare var KnownNonAdSignifiers: string[];
/** Segment URL substrings that identify ad segments. */
declare var AdSegmentURLPatterns: string[];
declare var TwitchAdUrlRewriteRegex: RegExp;
declare var UriAttributeRegex: RegExp;
declare var ClientID: string;
/** Player types tried, in order, when searching for an ad-free backup stream. */
declare var BackupPlayerTypes: PlayerType[];
declare var FallbackPlayerType: PlayerType;
/** Player type used for access-token requests (localStorage twitchAdSolutions_playerType). */
declare var ForceAccessTokenPlayerType: PlayerType;
declare var PreferLowQualityBackup: boolean;
declare var FastAutoplayFirstTry: boolean;
declare var BackupSwapFirst: boolean;
declare var DisableAdSpoofing: boolean;
declare var RecoverFromSilentMute: boolean;
declare var SoftReloadNoStrip: boolean;
declare var DisablePostBreakWedge: boolean;
declare var SkipPlayerReloadOnHevc: boolean;
declare var AlwaysReloadPlayerOnAd: boolean;
declare var ReloadPlayerAfterAd: boolean;
declare var ReloadCooldownSeconds: number;
declare var DisableReloadCap: boolean;
declare var DriftCorrectionRate: number;
declare var EarlyReloadPollThreshold: number;
declare var PinBackupPlayerType: boolean;
declare var PlayerReloadMinimalRequestsTime: number;
declare var PlayerReloadMinimalRequestsPlayerIndex: number;
declare var HasTriggeredPlayerReload: boolean;
/** Channel name -> stream state. Created with Object.create(null). */
declare var StreamInfos: Record<string, StreamInfo>;
/** Variant playlist URL -> owning stream state. Created with Object.create(null). */
declare var StreamInfosByUrl: Record<string, StreamInfo>;
declare var GQLDeviceID: string | null;
declare var ClientVersion: string | null;
declare var ClientSession: string | null;
declare var ClientIntegrityHeader: string | null;
declare var AuthorizationHeader: string | undefined;
declare var SimulatedAdsDepth: number;
declare var PlayerBufferingFix: boolean;
declare var PlayerBufferingDelay: number;
declare var PlayerBufferingSameStateCount: number;
declare var PlayerBufferingDangerZone: number;
declare var PlayerBufferingDoPlayerReload: boolean;
declare var PlayerBufferingMinRepeatDelay: number;
declare var PlayerBufferingPrerollCheckEnabled: boolean;
declare var PlayerBufferingPrerollCheckOffset: number;
declare var V2API: boolean;
declare var IsAdStrippingEnabled: boolean;
/** Ad segment URL -> time it was cached (ms). The worker fetch hook answers these with a blank MP4. */
declare var AdSegmentCache: Map<string, number>;
declare var AllSegmentsAreAdSegments: boolean;
declare var StreamInfoMaxAgeMs: number;

// ---------------------------------------------------------------------------
// Worker-only globals, declared inline in the worker blob template (hookWindowWorker).
// ---------------------------------------------------------------------------

/** In-flight GQL requests relayed to the page, by request id. */
declare var pendingFetchRequests: Map<
    string,
    {
        resolve: (response: Response) => void;
        reject: (error: Error) => void;
        timeoutId: ReturnType<typeof setTimeout>;
    }
>;

// ---------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------

/**
 * Twitch player types used for access tokens. Known values are listed for completeness;
 * any string from localStorage is accepted.
 */
type PlayerType = 'site' | 'popout' | 'mobile_web' | 'embed' | 'autoplay' | (string & {});

/** Video codec family of an m3u8 CODECS attribute (see videoCodecFamily). */
type VideoCodecFamily = 'avc' | 'hevc' | 'av1' | 'unknown';

/** One variant from the master (encodings) playlist. */
interface ResolutionInfo {
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
interface RecoverySegment {
    extinf: string;
    url: string;
}

/**
 * Per-channel stream state. createStreamInfo() builds the full shape; add new fields
 * there and here together.
 */
interface StreamInfo {
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
type M3u8Attributes = Record<string, any>;

// ---------------------------------------------------------------------------
// Messages between the page and the worker
// ---------------------------------------------------------------------------

/** 'early' = hard reload (new media player + token); 'post-ad' = soft reload. */
type ReloadKind = 'early' | 'post-ad';

interface AdBlockBannerMessage {
    key: 'UpdateAdBlockBanner';
    isMidroll: boolean;
    hasAds: boolean;
    isStrippingAdSegments: boolean;
    numStrippedAdSegments?: number;
    activeBackupPlayerType?: PlayerType | null;
}

/** A GQL request the worker asks the page to make (workers can't send credentialed requests). */
interface WorkerFetchRequest {
    id: string;
    url: string;
    options: RequestInit & { headers: Record<string, string> };
}

/** The page's answer to a WorkerFetchRequest. */
type WorkerFetchResponse =
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

/**
 * Messages posted by the worker to the page. Each postMessage call in the worker code checks
 * its literal against this with `@satisfies` (the global postMessage signature accepts any).
 */
type WorkerToPageMessage =
    | AdBlockBannerMessage
    | { key: 'PauseResumePlayer' }
    | { key: 'ReloadPlayer'; kind?: ReloadKind }
    | { key: 'FetchRequest'; value: WorkerFetchRequest };

/** Page -> worker message keys and the type of each message's `value`. */
interface PageToWorkerValues {
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
type PageToWorkerMessage = {
    [K in keyof PageToWorkerValues]: { key: K; value: PageToWorkerValues[K] };
}[keyof PageToWorkerValues];

// ---------------------------------------------------------------------------
// Page globals
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Page-side state (monitorPlayerBuffering and friends)
// ---------------------------------------------------------------------------

/** Buffer-monitor state shared by monitorPlayerBuffering(), doTwitchPlayerTask() and the worker message handler. */
interface PlayerBufferState {
    channelName: string | null;
    hasStreamStarted: boolean;
    position: number;
    bufferedPosition: number;
    bufferDuration: number;
    numSame: number;
    fixAttempts: number;
    lastFixTime: number;
    isLive: boolean;
    lastBackupSwitchAt: number;
    lastReloadAt: number;
    recoveryReloadUsed: boolean;
    userPauseIntent: boolean;
    loggedPauseIntent: boolean;
    /** Time of our last pause/play or reload (ms); 0 when none is pending. */
    weJustPaused: number;
    inAdBreak: boolean;
    vaftEverUnmuted: boolean;
    // Set lazily by the monitor. Left unset on purpose: videoCurrentTime is checked with `=== undefined`.
    videoElement?: HTMLVideoElement | null;
    videoCurrentTime?: number;
    lastDriftStartedAt?: number;
    hasHadData?: boolean;
    adStallStartAt?: number;
    lastAdStallReloadAt?: number;
    // Post-break video-wedge watch
    wedgePrevInAdBreak?: boolean;
    wedgeEvalsRemaining?: number;
    wedgeLastTime?: number;
    wedgeLastFrames?: number;
    wedgeEvidence?: number;
    wedgeHealthy?: number;
    wedgeActions?: number;
}

// ---------------------------------------------------------------------------
// Twitch internals reached through React (getPlayerAndState). Undocumented and liable to
// change without notice, so everything vaft reads is optional and only what it uses is listed.
// ---------------------------------------------------------------------------

/** A React fiber node. */
interface ReactFiber {
    // biome-ignore lint/suspicious/noExplicitAny: React component instances of any shape
    stateNode?: any;
    child?: ReactFiber | null;
    sibling?: ReactFiber | null;
}

/** The #root element, carrying React's internal container properties. */
type ReactRootElement = Element & {
    _reactRootContainer?: { _internalRoot?: { current?: ReactFiber } };
    // biome-ignore lint/suspicious/noExplicitAny: React's __reactContainer$<random> / __reactFiber$<random> keys
    [key: string]: any;
};

/** Twitch's (IVS) media player instance. */
interface TwitchMediaPlayer {
    core?: {
        paused?: boolean;
        state?: {
            path?: string;
            position?: number;
            bufferedPosition?: number;
            muted?: boolean;
            volume?: number | string;
            quality?: { group?: string };
        };
    };
    getHTMLVideoElement(): HTMLVideoElement | null | undefined;
    getBufferDuration(): number;
    getState(): string;
    isPaused(): boolean;
    play(): Promise<void> | undefined;
    pause(): void;
}

/** Twitch's player-state component: owns setSrc() and the content metadata. */
interface TwitchPlayerState {
    setSrc(options: { isNewMediaPlayerInstance: boolean; refreshAccessToken: boolean }): void;
    props?: { content?: { type?: string } };
}

interface HTMLVideoElement {
    /** Set once monitorPlayerBuffering() has attached its pause/play intent listeners. */
    __tasIntentHooked?: boolean;
}

interface Function {
    /** Set on URL.revokeObjectURL once hookWindowWorker() has wrapped it, so it's wrapped only once. */
    __tasMasked?: boolean;
}

interface Window {
    /** Version of the vaft copy that claimed this page; a lower/equal copy skips itself. */
    twitchAdSolutionsVersion?: number;
    /** The page's original fetch, saved before hookFetch() replaces it. */
    realFetch: typeof fetch;
    /** Console helpers. */
    reloadTwitchPlayer: () => void;
    simulateAds: (depth: number) => void;
    allSegmentsAreAdSegments: () => void;
}
