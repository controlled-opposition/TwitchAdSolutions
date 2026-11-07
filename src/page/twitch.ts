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
// "Not found" log state (see the grace period at the end of getPlayerAndState).
let firstPlayerNullAt = 0;
let loggedNoPlayer = false;
let firstStateNullAt = 0;
let loggedNoState = false;
// Traverse React's fiber tree to find Twitch's player and player state instances
export function getPlayerAndState() {
    /** Returns the matching component instance (Twitch internals, untyped). */
    function findReactNode(root: ReactFiber, constraint: (stateNode: ReactInstance) => unknown): ReactInstance {
        if (root.stateNode && constraint(root.stateNode)) {
            return root.stateNode;
        }
        let node = root.child;
        while (node) {
            const result: ReactInstance = findReactNode(node, constraint);
            if (result) {
                return result;
            }
            node = node.sibling;
        }
        return null;
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
            const containerName = Object.keys(rootNode).find(
                (x) => x.startsWith('__reactContainer') || x.startsWith('__reactFiber'),
            );
            if (containerName != null) {
                reactRootNode = rootNode[containerName];
            }
        }
        return reactRootNode;
    }
    const reactRootNode = findReactRootNode();
    if (!reactRootNode) {
        return null;
    }
    // Primary: named property lookup
    let player = findReactNode(
        reactRootNode,
        (node) => node.setPlayerActive && node.props && node.props.mediaPlayerInstance,
    );
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
    // Primary: named property lookup
    const playerState = findReactNode(reactRootNode, (node) => node.setSrc && node.setInitialPlaybackSettings);
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
