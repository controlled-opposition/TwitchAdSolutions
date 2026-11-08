// Twitch internals reached through React: undocumented and liable to change, so every member
// vaft reads is optional.

// biome-ignore lint/suspicious/noExplicitAny: React component instances of any shape
type ReactInstance = any;

interface ReactFiber {
    stateNode?: ReactInstance;
    child?: ReactFiber | null;
    sibling?: ReactFiber | null;
}

type ReactRootElement = Element & {
    _reactRootContainer?: { _internalRoot?: { current?: ReactFiber } };
    [key: string]: unknown;
};

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

export interface TwitchPlayerState {
    setSrc(options: { isNewMediaPlayerInstance: boolean; refreshAccessToken: boolean }): void;
    props?: { content?: { type?: string } };
}

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
// #root never changes in Twitch's React app.
let cachedRootNode: ReactRootElement | null = null;
let cachedContainerKey: string | null = null;
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
            Object.keys(rootNode).find((x) => x.startsWith('__reactContainer') || x.startsWith('__reactFiber')) ?? null;
        if (cachedContainerKey != null) {
            reactRootNode = rootNode[cachedContainerKey] as ReactFiber;
        }
    }
    return reactRootNode;
}
let firstPlayerNullAt = 0;
let loggedNoPlayer = false;
let firstStateNullAt = 0;
let loggedNoState = false;
export function getPlayerAndState() {
    const reactRootNode = findReactRootNode();
    if (!reactRootNode) {
        return null;
    }
    let [player, playerState] = findReactNodes(reactRootNode, [
        (node) => node.setPlayerActive && node.props && node.props.mediaPlayerInstance,
        (node) => node.setSrc && node.setInitialPlaybackSettings,
    ]);
    player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
    if (player?.playerInstance) {
        player = player.playerInstance;
    }
    if (!player) {
        player = findReactNode(
            reactRootNode,
            (node) => node.getHTMLVideoElement && node.getBufferDuration && node.core?.state,
        );
    }
    const playerStateFallback = !playerState
        ? findReactNode(reactRootNode, (node) => node.setSrc && node.setStreamManagerNode && !node.getHTMLVideoElement)
        : null;
    const playerStateFallback2 =
        !playerState && !playerStateFallback
            ? findReactNode(reactRootNode, (node) => node.state?.videoPlayerInstance?.playerMode !== undefined)?.state
                  ?.videoPlayerInstance
            : null;
    const finalPlayerState = playerState || playerStateFallback || playerStateFallback2;
    // The monitor can tick before Twitch mounts the player; a null lasting 10s means Twitch renamed
    // the internals matched above.
    if (!player) {
        if (!firstPlayerNullAt) firstPlayerNullAt = Date.now();
        if (!loggedNoPlayer && Date.now() - firstPlayerNullAt > 10000) {
            loggedNoPlayer = true;
            console.log(
                '[AD DEBUG] Player not found for 10s+ — Twitch may have renamed setPlayerActive/mediaPlayerInstance',
            );
        }
    } else {
        firstPlayerNullAt = 0;
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
        firstStateNullAt = 0;
    }
    return {
        player: player as TwitchMediaPlayer | null,
        state: finalPlayerState as TwitchPlayerState | null,
    };
}
// Since July 2026 Twitch can put a separate ad <video> before the player's in the DOM (#249);
// skip the ones hideTwitchAdOverlays marked.
export function getPlayerVideoElement() {
    const videos = document.getElementsByTagName('video');
    for (let i = 0; i < videos.length; i++) {
        if (!videos[i].dataset.tasAdHidden) {
            return videos[i];
        }
    }
    return null;
}
