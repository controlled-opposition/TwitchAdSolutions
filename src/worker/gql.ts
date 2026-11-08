import type { PlayerType } from '../shared/types.ts';
import { state } from './state.ts';
import { postToPage } from './post.ts';

export const pendingFetchRequests = new Map<
    string,
    {
        resolve: (response: Response) => void;
        reject: (error: Error) => void;
        timeoutId: ReturnType<typeof setTimeout>;
    }
>();

export function getAccessToken(channelName: string, playerType: PlayerType): Promise<Response> {
    const body = {
        operationName: 'PlaybackAccessToken',
        variables: {
            isLive: true,
            login: channelName,
            isVod: false,
            vodID: '',
            playerType: playerType,
            platform: playerType === 'autoplay' ? 'android' : 'web',
        },
        extensions: {
            persistedQuery: {
                version: 1,
                sha256Hash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9',
            },
        },
    };
    return gqlRequest(body);
}
export function gqlRequest(body: object | object[]): Promise<Response> {
    if (!state.GQLDeviceID) {
        state.GQLDeviceID = '';
        const dcharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
        const dcharactersLength = dcharacters.length;
        for (let i = 0; i < 32; i++) {
            state.GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
        }
    }
    const headers = {
        'Client-ID': state.ClientID,
        'X-Device-Id': state.GQLDeviceID,
        // Omitted when logged out: an undefined value would go out as the literal header "Authorization: undefined".
        ...(state.AuthorizationHeader && { Authorization: state.AuthorizationHeader }),
        ...(state.ClientIntegrityHeader && { 'Client-Integrity': state.ClientIntegrityHeader }),
        ...(state.ClientVersion && { 'Client-Version': state.ClientVersion }),
        ...(state.ClientSession && { 'Client-Session-Id': state.ClientSession }),
    };
    return new Promise((resolve, reject) => {
        const requestId = Math.random().toString(36).substring(2, 15);
        const fetchRequest = {
            id: requestId,
            url: 'https://gql.twitch.tv/gql',
            options: {
                method: 'POST',
                body: JSON.stringify(body),
                headers,
            },
        };
        const timeoutId = setTimeout(() => {
            if (pendingFetchRequests.has(requestId)) {
                pendingFetchRequests.delete(requestId);
                reject(new Error('FetchRequest timed out'));
            }
        }, 15000);
        pendingFetchRequests.set(requestId, {
            resolve,
            reject,
            timeoutId,
        });
        postToPage({
            key: 'FetchRequest',
            value: fetchRequest,
        });
    });
}
