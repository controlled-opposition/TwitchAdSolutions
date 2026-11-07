// Page globals vaft reads or adds.
export {};

declare global {
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

    interface HTMLVideoElement {
        /** Set once monitorPlayerBuffering() has attached its pause/play intent listeners. */
        __tasIntentHooked?: boolean;
    }

    interface Function {
        /** Set on URL.revokeObjectURL once hookWindowWorker() has wrapped it, so it's wrapped only once. */
        __tasMasked?: boolean;
    }
}
