import { installHook } from '../shared/hook.ts';
import { startBufferMonitor } from './buffer-monitor.ts';
import { hookFetch, hookXhr } from './fetch-hook.ts';
import { doTwitchPlayerTask } from './player.ts';
import { state } from './state.ts';
import { loadLocalStorageConfig, onContentLoaded } from './storage.ts';
import { hookWindowWorker } from './worker-hook.ts';
import { postTwitchWorkerMessage } from './workers.ts';

const ourTwitchAdSolutionsVersion = 98;

function main() {
    // Userscript managers inject into every matching frame, and Twitch's channel page holds hidden
    // cross-origin iframes. Only Twitch's embed contexts host a player in a nested frame
    // (https://dev.twitch.tv/docs/embed/video-and-clips/).
    // Not `window !== window.top`: Tampermonkey's window proxy can make that true on the top frame.
    let _isNested = false;
    try {
        _isNested = window.frameElement !== null;
    } catch (_e) {
        _isNested = true;
    }
    if (_isNested) {
        const _host = document.location.hostname;
        const _isEmbedContext =
            _host === 'player.twitch.tv' ||
            _host === 'embed.twitch.tv' ||
            document.location.pathname.startsWith('/embed/');
        if (!_isEmbedContext) {
            console.log(
                '[AD DEBUG] vaft skipped — nested frame on ' +
                    _host +
                    document.location.pathname +
                    ' (not a Twitch embed). If you see this on twitch.tv/CHANNEL top frame, please report.',
            );
            return;
        }
    }
    // Clip editor (clips.twitch.tv or /<channel>/clip/<slug>): the hooks froze its preview while
    // dragging the trim range (TTV-AB v6.4.9).
    {
        const _clipHost = document.location.hostname;
        const _clipPath = document.location.pathname || '';
        if (_clipHost === 'clips.twitch.tv' || /^\/[^/]+\/clip\/[^/]+/.test(_clipPath)) {
            console.log('[AD DEBUG] vaft skipped — clip editor page (' + _clipHost + _clipPath + ').');
            return;
        }
    }
    console.log('[AD DEBUG] TwitchAdSolutions vaft v' + ourTwitchAdSolutionsVersion + ' loading');
    if (
        typeof window.twitchAdSolutionsVersion !== 'undefined' &&
        window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion
    ) {
        console.log(
            '[AD DEBUG] CONFLICT: vaft v' +
                ourTwitchAdSolutionsVersion +
                ' skipped — another script already active (v' +
                window.twitchAdSolutionsVersion +
                '). Remove duplicate scripts.',
        );
        return;
    }
    installHook(window, 'twitchAdSolutionsVersion', ourTwitchAdSolutionsVersion, 'window.twitchAdSolutionsVersion');
    installHook(
        window,
        'reloadTwitchPlayer',
        () => {
            doTwitchPlayerTask('reload');
        },
        'window.reloadTwitchPlayer',
    );
    loadLocalStorageConfig();
    console.log(
        '[AD DEBUG] Config: ReloadPlayerAfterAd = ' +
            state.ReloadPlayerAfterAd +
            ', ForceAccessTokenPlayerType = ' +
            state.ForceAccessTokenPlayerType +
            ', PinBackupPlayerType = ' +
            state.PinBackupPlayerType,
    );
    hookWindowWorker();
    hookFetch();
    hookXhr();
    startBufferMonitor();
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        onContentLoaded();
    } else {
        window.addEventListener('DOMContentLoaded', function () {
            onContentLoaded();
        });
    }
    installHook(
        window,
        'simulateAds',
        (depth?: number) => {
            if (depth === undefined || depth < 0) {
                console.log(
                    'Ad depth parameter required (0 = no simulated ad, 1+ = use backup player for given depth)',
                );
                return;
            }
            postTwitchWorkerMessage('SimulateAds', depth);
        },
        'window.simulateAds',
    );
    installHook(
        window,
        'allSegmentsAreAdSegments',
        () => {
            postTwitchWorkerMessage('AllSegmentsAreAdSegments');
        },
        'window.allSegmentsAreAdSegments',
    );
}

main();
