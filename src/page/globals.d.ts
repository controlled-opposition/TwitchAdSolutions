export {};

declare global {
    interface Window {
        /** Version of the vaft copy that claimed this page; a lower/equal copy skips itself. */
        twitchAdSolutionsVersion?: number;
        realFetch: typeof fetch;
        reloadTwitchPlayer: () => void;
        simulateAds: (depth: number) => void;
        allSegmentsAreAdSegments: () => void;
    }

    interface HTMLVideoElement {
        __tasIntentHooked?: boolean;
    }

    interface Function {
        __tasMasked?: boolean;
    }
}
