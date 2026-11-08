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
 * Early-reload sub-machine of an ad break (see src/worker/early-reload.ts).
 *
 *     armed ──freeze long enough, budget left──▶ requested ──page reloaded──▶ reloaded ──next poll──▶ armed
 *       ▲                                            │
 *       └──────── page skipped it / couldn't / no answer in time ┘
 */
export type EarlyReloadState =
    | { phase: 'armed' }
    /** ReloadPlayer posted; waiting for the page's ReloadResult. */
    | { phase: 'requested'; requestId: number; at: number }
    /** The page reloaded; the next poll reports how it went. */
    | { phase: 'reloaded' };

/**
 * How a break's polls are handled (src/worker/m3u8.ts):
 * - `probing`: not settled; each poll checks the CSAI fast path, else searches for a backup.
 * - `sticky-csai`: the break was confirmed CSAI-only (every segment live); stays on the fast path.
 * - `escaped`: left `sticky-csai` through the PreferLowQualityBackup escape hatch; never returns to it.
 */
export type BreakPath = 'probing' | 'sticky-csai' | 'escaped';

/**
 * Candidate end of an ad break: started by the first ad-free poll, kept across short bounces
 * back to ad-marked polls (see src/worker/ad-break.ts).
 */
export interface AdBreakEnd {
    /** First ad-free poll of this candidate (ms). */
    since: number;
    /** Consecutive ad-free polls. */
    cleanPolls: number;
    /** Ad-marked polls seen while this candidate was alive (telemetry). */
    bounces: number;
}

/**
 * State of one ad break. Created by createAdBreak() on the first ad-marked poll and dropped
 * when the break ends, so nothing in it needs resetting by hand.
 */
export interface AdBreak {
    StartedAt: number;
    IsMidroll: boolean;
    PodLength: number;
    /** The break's playlist carried high-confidence ad attributes (ad session id / RADS token). */
    HasConfirmedAdAttrs: boolean;
    End: AdBreakEnd | null;
    Path: BreakPath;
    // Stripping
    /** The last poll stripped something. */
    IsStripping: boolean;
    /** Ad segments stripped over the whole break (each URL counted once). */
    StrippedSegments: number;
    RecoverySegments: RecoverySegment[];
    /** LOAD-BEARING: checked with `!== undefined`. */
    RecoveryStartSeq: number | undefined;
    FreezeStartedAt: number;
    ConsecutiveAllStrippedPolls: number;
    TotalAllStrippedPolls: number;
    // Backup player types
    ActiveBackupPlayerType: PlayerType | null;
    LastCommittedBackupPlayerType: PlayerType | null;
    /** Player type -> failure time (ms); entries expire for retry. */
    FailedBackupPlayerTypes: Map<PlayerType, number>;
    /** Player types whose playlist carried ads this break. */
    ContaminatedTypes: Set<PlayerType>;
    /** A freeze was ended by switching to a different clean backup type. */
    CycleRescued: boolean;
    /** Whether this break tries autoplay first (decided on its first backup search; null before). */
    AutoplayFirst: boolean | null;
    // Early reload
    EarlyReload: EarlyReloadState;
    EarlyReloadCount: number;
    EarlyReloadAtPoll: number;
    /** A codec-swap reload was attempted this break (not retried if the page couldn't do it). */
    CodecSwapTried: boolean;
    // Ad-segment prefetch and spoofing
    RequestedAds: Set<string>;
    /** Stitched-ad IDs already spoofed this break. */
    SpoofedAdIds: Set<string>;
    // Once-per-break logs
    LoggedAdAttributes: boolean;
    LoggedUnknownSignifiers: boolean;
    LoggedContamReorder: boolean;
    LoggedAutoplayOrder: boolean;
}

/**
 * Codec swap for HEVC/AV1 streams (backups are AVC, so the player has to be on AVC variants):
 *
 *     native ──ad, enhanced codec──▶ switching ──page reloaded──▶ swapped ──break end (reload)──▶ native
 *                                       └──── page didn't reload ────▶ native
 *
 * The master playlist served to the player is the AVC-only ModifiedM3U8 unless `native`.
 */
export type CodecSwapState = 'native' | 'switching' | 'swapped';

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
    // Codec swap
    ModifiedM3U8: string | null;
    CodecSwap: CodecSwapState;
    /** The ad break in progress, null between breaks. */
    Break: AdBreak | null;
    ConsecutiveZeroStripBreaks: number;
    LastAdCachePruneAt: number;
    // Clean playlist snapshot for all-stripped recovery
    LastCleanNativeM3U8: string | null;
    LastCleanNativePlaylistAt: number;
    // Backup player types, across breaks
    /** Player type -> encodings m3u8 fetched for it (null once used). */
    BackupEncodingsM3U8Cache: Record<string, string | null>;
    PinnedBackupPlayerType: PlayerType | null;
    /**
     * Every Source-tier type was ad-laden in a recent break and autoplay (360p) won, so later
     * breaks try autoplay first (FastAutoplayFirstTry). Cleared when a Source-tier type wins.
     */
    SourceTierExhausted: boolean;
    /** Breaks won by autoplay-first in a row; every FAST_AUTOPLAY_REPROBE_INTERVAL'th break re-probes Source. */
    FastAutoplayWins: number;
    // Last player reload (post-ad re-entry guards, minimal-request window)
    LastPlayerReload: number;
    /** The page reported a reload (TriggeredPlayerReload); this stream's next poll stamps LastPlayerReload. */
    ReloadPending: boolean;
    // Diagnostics
    HasCheckedUnknownTags: boolean;
    LoggedOfflineTransition: boolean;
    ConsecutiveTokenFetchFailures: number;
    LoggedTokenFailureStreak: boolean;
    LoggedAdCacheSize1k: boolean;
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

/**
 * - `early`: hard reload (new media player + access token).
 * - `post-ad`: soft reload.
 * - `codec-swap`: soft reload onto the AVC-only master playlist; never skipped as "player healthy".
 * - none: soft reload, skipped while the player is healthy and near live.
 */
export type ReloadKind = 'early' | 'post-ad' | 'codec-swap';

/** What the page did with a reload request (see doTwitchPlayerTask). */
export type ReloadOutcome = 'reloaded' | 'skipped-healthy' | 'not-done';

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
    /** `requestId` asks the page to answer with a ReloadResult. */
    | { key: 'ReloadPlayer'; kind?: ReloadKind; requestId?: number }
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
    /** The page reloaded the player (for any reason). */
    TriggeredPlayerReload: undefined;
    /** Answer to a ReloadPlayer that carried a requestId. */
    ReloadResult: { requestId: number; outcome: ReloadOutcome };
    /** Debug toggle (window.allSegmentsAreAdSegments). */
    AllSegmentsAreAdSegments: undefined;
    /** Debug: window.simulateAds(depth). */
    SimulateAds: number;
}

/** Messages posted by the page to the worker (postTwitchWorkerMessage). */
export type PageToWorkerMessage = {
    [K in keyof PageToWorkerValues]: { key: K; value: PageToWorkerValues[K] };
}[keyof PageToWorkerValues];
