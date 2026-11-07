// Twitch internals reached through React (getPlayerAndState). Undocumented and liable to
// change without notice, so everything vaft reads is optional and only what it uses is listed.

/** A React component instance. Untyped: findReactNode() matches on whatever shape Twitch's are. */
// biome-ignore lint/suspicious/noExplicitAny: React component instances of any shape
type ReactInstance = any;

/** A React fiber node. */
export interface ReactFiber {
    stateNode?: ReactInstance;
    child?: ReactFiber | null;
    sibling?: ReactFiber | null;
}

/** The #root element, carrying React's internal container properties. */
export type ReactRootElement = Element & {
    _reactRootContainer?: { _internalRoot?: { current?: ReactFiber } };
    // biome-ignore lint/suspicious/noExplicitAny: React's __reactContainer$<random> / __reactFiber$<random> keys
    [key: string]: any;
};

/** Twitch's (IVS) media player instance. */
export interface TwitchMediaPlayer {
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
export interface TwitchPlayerState {
    setSrc(options: { isNewMediaPlayerInstance: boolean; refreshAccessToken: boolean }): void;
    props?: { content?: { type?: string } };
}

/** Cached #root element (never changes in React SPAs). */
let cachedRootNode: ReactRootElement | null = null;
/** Own-property key of #root that holds the React 18 root fiber, once found. */
let cachedContainerKey: string | null = null;
// "Not found" log state (see the grace period at the end of getPlayerAndState).
let firstPlayerNullAt = 0;
let loggedNoPlayer = false;
let firstStateNullAt = 0;
let loggedNoState = false;
// Traverse React's fiber tree to find Twitch's player and player state instances
export function getPlayerAndState() {
    /**
     * One pre-order walk of the fiber tree returning, for each constraint, the first component
     * instance that satisfies it (Twitch internals, untyped). Stops once every constraint has
     * matched, so finding several instances costs one walk instead of one each.
     */
    function findReactNodes(root: ReactFiber, constraints: ((stateNode: ReactInstance) => unknown)[]): ReactInstance[] {
        const found: ReactInstance[] = constraints.map(() => null);
        let remaining = constraints.length;
        function visit(fiber: ReactFiber): boolean {
            const stateNode = fiber.stateNode;
            if (stateNode) {
                for (let i = 0; i < constraints.length; i++) {
                    if (!found[i] && constraints[i](stateNode)) {
                        found[i] = stateNode;
                        if (--remaining === 0) return true;
                    }
                }
            }
            for (let node = fiber.child; node; node = node.sibling) {
                if (visit(node)) return true;
            }
            return false;
        }
        visit(root);
        return found;
    }
    function findReactNode(root: ReactFiber, constraint: (stateNode: ReactInstance) => unknown): ReactInstance {
        return findReactNodes(root, [constraint])[0];
    }
    function findReactRootNode(): ReactFiber | null {
        let reactRootNode: ReactFiber | null = null;
        if (!cachedRootNode) {
            cachedRootNode = document.querySelector('#root') as ReactRootElement | null;
        }
        const rootNode = cachedRootNode;
        if (
            rootNode &&
            rootNode._reactRootContainer &&
            rootNode._reactRootContainer._internalRoot &&
            rootNode._reactRootContainer._internalRoot.current
        ) {
            reactRootNode = rootNode._reactRootContainer._internalRoot.current;
        }
        if (reactRootNode == null && rootNode != null) {
            // React 18 keeps the root fiber under a per-page randomised key; find it once.
            cachedContainerKey ??=
                Object.keys(rootNode).find((x) => x.startsWith('__reactContainer') || x.startsWith('__reactFiber')) ??
                null;
            if (cachedContainerKey != null) {
                reactRootNode = rootNode[cachedContainerKey];
            }
        }
        return reactRootNode;
    }
    const reactRootNode = findReactRootNode();
    if (!reactRootNode) {
        return null;
    }
    // Primary: named property lookups for both instances, in a single walk
    let [player, playerState] = findReactNodes(reactRootNode, [
        (node) => node.setPlayerActive && node.props && node.props.mediaPlayerInstance,
        (node) => node.setSrc && node.setInitialPlaybackSettings,
    ]);
    player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
    if (player?.playerInstance) {
        player = player.playerInstance;
    }
    // Fallback: structural match if Twitch obfuscates property names
    if (!player) {
        player = findReactNode(
            reactRootNode,
            (node) => node.getHTMLVideoElement && node.getBufferDuration && node.core?.state,
        );
    }
    // Fallback: structural match — setSrc exists but setInitialPlaybackSettings was renamed
    const playerStateFallback = !playerState
        ? findReactNode(reactRootNode, (node) => node.setSrc && node.setStreamManagerNode && !node.getHTMLVideoElement)
        : null;
    // Fallback 2: TTV-AB's approach — videoPlayerInstance with playerMode
    const playerStateFallback2 =
        !playerState && !playerStateFallback
            ? findReactNode(reactRootNode, (node) => node.state?.videoPlayerInstance?.playerMode !== undefined)?.state
                  ?.videoPlayerInstance
            : null;
    const finalPlayerState = playerState || playerStateFallback || playerStateFallback2;
    // Grace period before logging "not found" warnings. The buffer monitor can tick
    // before React has finished mounting the player, leading to a false-positive
    // log that fires once on every page load. Only log if the null state persists
    // for 10+ seconds — by then React is definitely mounted and a persistent null
    // indicates real API drift (Twitch renamed setPlayerActive/setSrc/etc).
    if (!player) {
        if (!firstPlayerNullAt) firstPlayerNullAt = Date.now();
        if (!loggedNoPlayer && Date.now() - firstPlayerNullAt > 10000) {
            loggedNoPlayer = true;
            console.log(
                '[AD DEBUG] Player not found for 10s+ — Twitch may have renamed setPlayerActive/mediaPlayerInstance',
            );
        }
    } else {
        firstPlayerNullAt = 0; // reset on successful find
    }
    if (!finalPlayerState) {
        if (!firstStateNullAt) firstStateNullAt = Date.now();
        if (!loggedNoState && Date.now() - firstStateNullAt > 10000) {
            loggedNoState = true;
            console.log(
                '[AD DEBUG] Player state not found for 10s+ — Twitch may have renamed setSrc/setInitialPlaybackSettings',
            );
        }
    } else {
        firstStateNullAt = 0; // reset on successful find
    }
    return {
        player: player as TwitchMediaPlayer | null,
        state: finalPlayerState as TwitchPlayerState | null,
    };
}
// document.querySelector('video') returns the first <video> in the DOM, which since
// July 2026 can be a separate Twitch ad element beside the player or in chat (#249).
// Skip anything the guard below has marked, so mute/playbackRate work always lands on
// the real player instead of being aimed at — or skipped because of — an ad element.
export function getPlayerVideoElement() {
    const videos = document.getElementsByTagName('video');
    for (let i = 0; i < videos.length; i++) {
        if (!videos[i].dataset.tasAdHidden) {
            return videos[i];
        }
    }
    return null;
}
