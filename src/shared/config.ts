import type { PageToWorkerValues, SharedConfig } from './types.ts';

export function defaultSharedConfig(): SharedConfig {
    return {
        ReloadPlayerAfterAd: true,
        EarlyReloadPollThreshold: 3, // Twitch's player polls the playlist about every 2s
        PinBackupPlayerType: true,
        PreferLowQualityBackup: true, // autoplay tokens only get a 360p variant ladder
        // Field data: every observed channel serves ads on every Source-tier backup type.
        FastAutoplayFirstTry: true,
        // Users report fewer loading circles than with stripping in place (no MediaSource mixing).
        BackupSwapFirst: true,
        // Off: Twitch may fingerprint the always-complete beacon pattern while still answering 200
        // (TTV-AB maintainer hypothesis).
        DisableAdSpoofing: true,
        // Issue #129 mode D. A hard reload shows a black screen and play icon on desktop; its
        // MediaSource flush is only needed after strip injection.
        SoftReloadNoStrip: true,
        ForceAccessTokenPlayerType: 'popout',
        GQLDeviceID: null,
        AuthorizationHeader: undefined,
        ClientIntegrityHeader: null,
        ClientVersion: null,
        ClientSession: null,
    };
}

export const GQL_HEADER_RELAYS = [
    { headers: ['X-Device-Id', 'Device-ID'], field: 'GQLDeviceID', key: 'UpdateDeviceId' },
    { headers: ['Client-Version'], field: 'ClientVersion', key: 'UpdateClientVersion' },
    { headers: ['Client-Session-Id'], field: 'ClientSession', key: 'UpdateClientSession' },
    { headers: ['Client-Integrity'], field: 'ClientIntegrityHeader', key: 'UpdateClientIntegrityHeader' },
    { headers: ['Authorization'], field: 'AuthorizationHeader', key: 'UpdateAuthorizationHeader' },
] as const satisfies readonly {
    headers: readonly string[];
    field: keyof SharedConfig;
    key: keyof PageToWorkerValues;
}[];

export function pickSharedConfig(source: SharedConfig): SharedConfig {
    const config = defaultSharedConfig();
    for (const key of Object.keys(config) as (keyof SharedConfig)[]) {
        (config as Record<keyof SharedConfig, unknown>)[key] = source[key];
    }
    return config;
}
