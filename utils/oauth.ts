import { crypto, toHashString } from "https://deno.land/std@0.173.0/crypto/mod.ts";
import {CONFIG} from "../config.ts";

// ALL of these are mandatory for some reason
const GRAPHQL_FEATURES = {
    "longform_notetweets_inline_media_enabled": true,
    "super_follow_badge_privacy_enabled": true,
    "longform_notetweets_rich_text_read_enabled": true,
    "super_follow_user_api_enabled": true,
    "super_follow_tweet_api_enabled": true,
    "hidden_profile_likes_enabled": false,
    "hidden_profile_subscriptions_enabled": false,
    "android_graphql_skip_api_media_color_palette": true,
    "creator_subscriptions_tweet_preview_api_enabled": true,
    "freedom_of_speech_not_reach_fetch_enabled": true,
    "tweetypie_unmention_optimization_enabled": true,
    "longform_notetweets_consumption_enabled": true,
    "subscriptions_verification_info_enabled": true,
    "blue_business_profile_image_shape_enabled": true,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": true,
    "super_follow_exclusive_tweet_notifications_enabled": true,
};

function percentEncode(s: string): string {
    return encodeURIComponent(s).replace(/['()*!]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function buildHmacKey(consumerSecret: string, accessTokenSecret: string): Promise<CryptoKey> {
    const string = percentEncode(consumerSecret) + '&' + percentEncode(accessTokenSecret);
    const buffer = new TextEncoder().encode(string).buffer;
    return crypto.subtle.importKey('raw', buffer, {name: 'HMAC', hash: 'SHA-1'}, false, ['sign']);
}

async function makeSignature(hmacKey: CryptoKey, oauthParams: Record<string, string>, method: string, url: string|URL, params: URLSearchParams|null): Promise<string> {
    const paramBits = [];

    for (const [key, value] of Object.entries(oauthParams)) {
        paramBits.push(`${percentEncode(key)}=${percentEncode(value)}`);
    }

    if (typeof url === 'string') {
        url = new URL(url);
    }
    url.searchParams.forEach((value, key) => {
        paramBits.push(`${percentEncode(key)}=${percentEncode(value)}`);
    });

    if (params !== null) {
        for (const [key, value] of Object.entries(params)) {
            paramBits.push(`${percentEncode(key)}=${percentEncode(value)}`);
        }
    }

    const parameterString = percentEncode(paramBits.sort().join('&'));
    const urlBase = percentEncode(url.origin + url.pathname);
    const baseString = `${method.toUpperCase()}&${urlBase}&${parameterString}`;
    const baseArray = new TextEncoder().encode(baseString);
    const hash = await crypto.subtle.sign('HMAC', hmacKey, baseArray.buffer);
    return toHashString(hash, 'base64');
}

export class OAuth {
    consumerKey: string;
    consumerSecret: string;
    accessToken: string;
    accessTokenSecret: string;
    myID: string;
    key?: CryptoKey;

    constructor(consumerKey: string, consumerSecret: string, accessToken: string, accessTokenSecret: string) {
        this.consumerKey = consumerKey;
        this.consumerSecret = consumerSecret;
        this.accessToken = accessToken;
        this.accessTokenSecret = accessTokenSecret;
        this.myID = accessToken.substring(0, accessToken.indexOf('-'));
    }

    async request(method: string, url: string|URL, queryParams?: Record<string, string>, bodyParams?: Record<string, string> | null, jsonBody?: boolean): Promise<Response> {
        if (this.key === undefined) {
            this.key = await buildHmacKey(this.consumerSecret, this.accessTokenSecret);
        }

        const oauthParams: Record<string, string> = {
            oauth_consumer_key: this.consumerKey,
            oauth_nonce: crypto.randomUUID().toUpperCase(),
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: Math.floor(new Date().getTime() / 1000).toString(),
            oauth_token: this.accessToken,
            oauth_version: '1.0',
            oauth_realm: "https://api.twitter.com/",
        };

        url = new URL(url);
        if (queryParams !== undefined) {
            for (const [key, value] of Object.entries(queryParams)) {
                url.searchParams.append(key, value);
            }
        }

        let body = null;
        if (bodyParams !== undefined && bodyParams !== null) {
            if (jsonBody) {
                body = JSON.stringify(bodyParams);
            } else {
                body = new URLSearchParams(bodyParams);
            }
        }

        // Confusingly, you're not meant to pass JSON bodies into the signature function, but you are if it's an XML body.
        oauthParams['oauth_signature'] = await makeSignature(this.key, oauthParams, method, url, jsonBody ? null : body);

        const oauthBits = [];
        for (const [key, value] of Object.entries(oauthParams)) {
            oauthBits.push(`${percentEncode(key)}="${percentEncode(value)}"`);
        }

        const headers: Record<string, string> = { ...CONFIG.headers };
        headers['Authorization'] = 'OAuth ' + oauthBits.join(', ');

        if (jsonBody) {
            headers['Content-Type'] = 'application/json';
        }

        return fetch(url, { body, headers, method });
    }

    get(url: string|URL, queryParams?: Record<string, string>, bodyParams?: Record<string, string> | null): Promise<Response> {
        return this.request('GET', url, queryParams, bodyParams);
    }
    post(url: string|URL, queryParams?: Record<string, string>, bodyParams?: Record<string, string> | null): Promise<Response> {
        return this.request('POST', url, queryParams, bodyParams);
    }

    async getGraphQL(key: string, variables: Record<string, any>, features?: Record<string, any>): Promise<Response> {
        const finalFeatures = {...GRAPHQL_FEATURES};
        if (features) {
            Object.assign(finalFeatures, features);
        }

        return this.request('GET', `https://api.twitter.com/graphql${key}`, {
            variables: JSON.stringify(variables),
            features: JSON.stringify(finalFeatures),
        }, undefined);
    }

    async postGraphQL(key: string, variables: Record<string, any>, features?: Record<string, any>): Promise<Response> {
        const finalFeatures = {...GRAPHQL_FEATURES};
        if (features) {
            Object.assign(finalFeatures, features);
        }

        return this.request('POST', `https://api.twitter.com/graphql${key}`, undefined, {
            variables: JSON.stringify(variables),
            features: JSON.stringify(finalFeatures),
        }, true);
    }
}
