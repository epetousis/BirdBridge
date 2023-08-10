// @deno-types="npm:@types/express@4.17.15"
import express from "npm:express@4.18.2";
import "npm:express-async-errors@3.1.1";
import multer from "npm:multer@1.4.5-lts.1";
import cors from "npm:cors@2.8.5";
import {userToAccount, tweetToToot, activityToNotification, graphQLTweetResultToToot} from "./conversion.ts";
import {OAuth} from "./utils/oauth.ts";
import {
    addPageLinksToResponse,
    BLUE_VERIFIED_EMOJI,
    buildParams,
    injectPagingInfo,
    PISS_VERIFIED_EMOJI, VERIFIED_EMOJI
} from "./utils/apiUtil.ts";
import {UserCache} from "./utils/userCache.ts";
import {CONFIG} from "./config.ts";
import {setup as setupAuthflow} from "./apis/authflow.ts";
import { red } from "https://deno.land/std@0.197.0/fmt/colors.ts";

console.log(red('Starting BirdBridge...'));

const userCacheMap = new Map<string, UserCache>();
function getUserCache(oauth: OAuth): UserCache {
    let cache = userCacheMap.get(oauth.accessToken);
    if (cache)
        return cache;
    cache = new UserCache(oauth);
    userCacheMap.set(oauth.accessToken, cache);
    return cache;
}

const app = express();
const upload = multer();
app.use(upload.none());

declare global {
    namespace Express {
        export interface Request {
            originalJsonBody?: Uint8Array
        }
    }
}
app.use(express.json({
    verify: (req, _res, body, _encoding) => {
        // a terrible, terrible hack that lets us get the original JSON later
        req.originalJsonBody = body;
    }
}));

app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use('/static', express.static(new URL('static', import.meta.url).pathname));

app.use((req, res, next) => {
    // Inject query params into the body
    if (req.body === null)
        req.body = {};
    for (const [key, value] of Object.entries(req.query)) {
        req.body[key] = value;
    }

    console.log('Request to', req.url);
    console.log('body:', req.body);
    next();
});

app.get('/api/v1/instance', (req, res) => {
    res.send({
        uri: CONFIG.domain,
        title: 'Twitter',
        short_description: 'A lazy bridge to Twitter',
        description: 'A lazy bridge to Twitter',
        email: 'example@example.com',
        version: '0.0.1',
        urls: {
            streaming_api: ''
        },
        stats: {
            user_count: 1,
            status_count: 99999,
            domain_count: 1
        },
        // no thumbnail
        languages: ['en'],
        registrations: false,
        approval_required: true,
        invites_enabled: false,
        configuration: {
            accounts: {
                max_featured_tags: 0
            },
            statuses: {
                max_characters: 280,
                max_media_attachments: 4,
                characters_reserved_per_url: 23 // FIXME
            },
            polls: {
                max_options: 4,
                max_characters_per_option: 20, // FIXME
                min_expiration: 1, // FIXME
                max_expiration: 100000 // FIXME
            }
            // TODO: media_attachments
        },
        // TODO: contact_account
        rules: []
    });
});

setupAuthflow(app);
// All routes added after this will require a valid OAuth token

app.get('/api/v1/accounts/verify_credentials', async (req, res) => {
    const twreq = await req.oauth!.request('GET', 'https://api.twitter.com/1.1/account/verify_credentials.json');
    const user = await twreq.json();

    const account = userToAccount(user);
    account.source = {
        privacy: user.protected ? 'private' : 'public',
        note: user.description
    };

    res.send(account);
});

app.get('/api/v1/timelines/home', async (req, res) => {
    const url = 'https://api.twitter.com/1.1/statuses/home_timeline.json';
    const params: Record<string, any> = buildParams(true);
    params.include_my_retweet = '1';
    injectPagingInfo(req.body, params);

    // The Mastodon API offers more flexibility in paging than Twitter does, so we need to
    // play games in order to get refreshing in Ivory to work.

    // If you reopen Ivory and there are 300 new posts, it tries to fetch them in order
    // from oldest to newest, by passing "min_id=X" where X is the most recent post it
    // saw. This doesn't work with Twitter - if we pass "since_id=X", we get the newest
    // 40 tweets.

    // Tweetbot has logic to detect this and fill the gap, but Ivory doesn't include it.
    // Thankfully, Ivory is okay with receiving more posts than it requested - so we can
    // just detect this case and do the backfilling ourselves.

    let tweets;
    if (req.body.min_id !== undefined && req.body.max_id === undefined && req.body.since_id === undefined) {
        // Ivory "get the latest posts" case detected
        tweets = [];

        const lastRead = BigInt(req.body.min_id as string);
        let maxID: BigInt | null = null;
        params.count = '200'; // we may as well load Twitter's maximum and save on requests!
        params.since_id = (lastRead - 1n).toString(); // fetch the last read tweet as well
        let done = false;

        console.log(`Tweet update request from ${lastRead} onwards`);

        while (!done) {
            let thisBatch;
            try {
                if (maxID !== null)
                    params.max_id = maxID.toString();

                const twreq = await req.oauth!.get(url, params);
                thisBatch = await twreq.json();
            } catch (ex) {
                console.error('Error while loading tweets', ex);
                break;
            }

            for (const tweet of thisBatch) {
                const id = BigInt(tweet.id_str);
                if (id <= lastRead) {
                    // We now know we have everything
                    console.log(`LastRead tweet ID seen, so we're done`);
                    done = true;
                    break;
                }

                if (maxID === null || id < maxID)
                    maxID = id - 1n;

                tweets.push(tweet);
            }

            console.log(`Loaded ${thisBatch.length} tweets (total now ${tweets.length}), new maxID=${maxID}`);

            // We requested 200 tweets, but because of filtering, we might not actually get
            // that many. So, if we got 150 or more (and we didn't see the 'last read' tweet),
            // we make another request. Otherwise, we bail.
            if (thisBatch.length < 150) {
                console.log(`Batch was under 150 tweets, so assume this is the end`);
                done = true;
            }
        }

        // For debugging, grab the IDs and dates of the oldest and newest tweets in this bundle
        let oldest = null, newest = null;
        for (const tweet of tweets) {
            if (oldest === null || BigInt(tweet.id_str) < BigInt(oldest.id_str))
                oldest = tweet;
            if (newest === null || BigInt(tweet.id_str) > BigInt(newest.id_str))
                newest = tweet;
        }

        console.log(`Returning ${tweets.length} tweets (${oldest?.id_str}, ${oldest?.created_at} -> ${newest?.id_str}, ${newest?.created_at})`);
    } else {
        // Stick to the original logic
        const twreq = await req.oauth!.get(url, params);
        tweets = await twreq.json();
    }

    const toots = tweets.map(tweetToToot);
    addPageLinksToResponse(new URL(req.originalUrl, CONFIG.root), toots as {id: string}[], res);
    res.send(toots);
});

function isMentionsTimelineQuery(data: any): boolean {
    if (data.types && Array.isArray(data.types)) {
        // for Ivory
        if ((data.types.length === 1 && data.types[0] === 'mention') ||
            (data.types.length === 2 && data.types[0] === 'mention' && data.types[1] === 'mention'))
            return true;
    } else if (data.exclude_types && Array.isArray(data.exclude_types)) {
        // for Pinafore
        const check = [
            'follow', 'favourite', 'reblog', 'poll',
            'admin.sign_up', 'update', 'follow_request', 'admin.report'
        ];
        if (data.exclude_types.length === check.length) {
            for (let i = 0; i < check.length; i++) {
                if (check[i] !== data.exclude_types[i])
                    return false;
            }
            return true;
        }
    }

    return false;
}

app.get('/api/v1/notifications', async (req, res) => {
    const params: Record<string, any> = buildParams(true);
    injectPagingInfo(req.body, params);

    if (isMentionsTimelineQuery(req.body)) {
        // special case for 'mentions' timeline
        const twreq = await req.oauth!.request('GET', 'https://api.twitter.com/1.1/statuses/mentions_timeline.json', params);
        const mentions = await twreq.json();
        const notifications = [];

        for (const mention of mentions) {
            const toot = tweetToToot(mention);
            notifications.push({
                account: toot.account,
                created_at: toot.created_at,
                id: toot.id,
                status: toot,
                type: 'mention'
            });
        }

        addPageLinksToResponse(new URL(req.originalUrl, CONFIG.root), notifications as { id: string }[], res);
        res.send(notifications);
    } else {
        // fetch the full notification feed
        // no filtering yet, i should probably fix that
        params.skip_aggregation = 'true';

        const twreq = await req.oauth!.request('GET', 'https://api.twitter.com/1.1/activity/about_me.json', params);
        const activities = await twreq.json();

        const notifications = [];
        for (const activity of activities) {
            const notification = activityToNotification(activity);
            if (notification !== null)
                notifications.push(notification);
        }

        addPageLinksToResponse(new URL(req.originalUrl, CONFIG.root), notifications as { id: string }[], res);

        res.send(notifications.filter(n => n.type !== 'invalid'));
    }
});

app.get('/api/v1/follow_requests', (req, res) => {
    res.send([]);
});

app.get('/api/v1/custom_emojis', (req, res) => {
    res.send([VERIFIED_EMOJI, BLUE_VERIFIED_EMOJI, PISS_VERIFIED_EMOJI]);
});

app.get('/api/v1/filters', (req, res) => {
    res.send([]);
});

app.get('/api/v1/favourites', async (req, res) => {
    const variables = {
        "includeTweetImpression":true,
        "includeHasBirdwatchNotes":false,
        "includeEditPerspective":false,
        "includeEditControl":true,
        "count":req.body.limit,
        "rest_id":req.oauth!.myID,
        "includeTweetVisibilityNudge":true,
    };
    const features = {
        "unified_cards_ad_metadata_container_dynamic_card_content_query_enabled": true,
    };
    const twreq = await req.oauth!.getGraphQL('/xUGO-xGK_bD7TWpW2des6Q/FavoritesByTimeTimelineV2', variables, features);
    const response = await twreq.json();
    const tweets = response.data.user_result.result.timeline_response.timeline.instructions
      .find((i) => i['__typename'] === 'TimelineAddEntries')
      .entries
      .map((e) => graphQLTweetResultToToot(e.content.content?.tweetResult.result))
      .filter((t) => !!t && t.user);
    const toots = tweets.map(tweetToToot);
    res.send(toots);
});

app.get('/api/v1/bookmarks', async (req, res) => {
    const variables = {
        "includeTweetImpression":true,
        "includeHasBirdwatchNotes":false,
        "includeEditPerspective":false,
        "includeEditControl":true,
        "count":req.body.limit,
        "includeTweetVisibilityNudge":true,
        // TODO: add pagination support via cursor
    };
    const features = {
        "unified_cards_ad_metadata_container_dynamic_card_content_query_enabled": true,
    };
    const twreq = await req.oauth!.getGraphQL('/E-Rqts_gtMp60KgQK2Xv9A/BookmarkTimelineV2', variables, features);
    const response = await twreq.json();
    const tweets = response.data.timeline_response.timeline.instructions
      .find((i) => i['__typename'] === 'TimelineAddEntries')
      .entries
      .map((e) => graphQLTweetResultToToot(e.content.content?.tweetResult.result))
      .filter((t) => !!t && t.user);
    const toots = tweets.map(tweetToToot);
    res.send(toots);
});

app.get('/api/v1/lists', async (req, res) => {
    const twreq = await req.oauth!.request(
        'GET',
        'https://api.twitter.com/1.1/lists/list.json',
        {user_id: req.oauth!.myID}
    );
    const twitterLists = await twreq.json();
    const lists = [];

    for (const twitterList of twitterLists) {
        lists.push({
            id: twitterList.id_str,
            title: twitterList.name,
            replies_policy: 'none'
        });
    }

    res.send(lists);
});

app.get('/api/v1/timelines/list/:list_id(\\d+)', async (req, res) => {
    const params: Record<string, any> = buildParams(true);
    params.list_id = req.params.list_id;
    injectPagingInfo(req.body, params);

    const twreq = await req.oauth!.request('GET', 'https://api.twitter.com/1.1/lists/statuses.json', params);
    const tweets = await twreq.json();
    const toots = tweets.map(tweetToToot);
    addPageLinksToResponse(new URL(req.originalUrl, CONFIG.root), toots as {id: string}[], res);
    res.send(toots);
});

app.get('/api/v1/accounts/:id(\\d+)', async (req, res) => {
    const userCache = getUserCache(req.oauth!);
    const user = await userCache.fetchUser(req.params.id);
    res.send(userToAccount(user));
});

app.get('/api/v1/accounts/:id(\\d+)/statuses', async (req, res) => {
    if (req.body.pinned) {
        const userCache = getUserCache(req.oauth!);
        const user = await userCache.fetchUser(req.params.id);
        const pinned = [];
        if (user.pinned_tweet_ids_str) {
            const params = buildParams(true);
            params.id = user.pinned_tweet_ids_str.join(',');
            const twreq = await req.oauth!.request('GET', 'https://api.twitter.com/1.1/statuses/lookup.json', params);
            const map = new Map();
            for (const tweet of await twreq.json()) {
                map.set(tweet.id_str, tweet);
            }
            for (const id of user.pinned_tweet_ids_str) {
                const tweet = map.get(id);
                if (tweet !== undefined)
                    pinned.push(tweetToToot(tweet));
            }
        }
        res.send(pinned);
        return;
    }

    const params = buildParams(true);
    params.user_id = req.params.id;
    injectPagingInfo(req.body, params);

    const twreq = await req.oauth!.request('GET', 'https://api.twitter.com/1.1/statuses/user_timeline.json', params);
    const tweets = await twreq.json();
    const toots = tweets.map(tweetToToot);
    addPageLinksToResponse(new URL(req.originalUrl, CONFIG.root), toots as {id: string}[], res);
    res.send(toots);
});

app.get('/api/v1/accounts/relationships', async (req, res) => {
    const results = [];

    if (req.body.id) {
        const ids = Array.isArray(req.body.id) ? req.body.id : [req.body.id];

        if (ids.length > 1)
            console.warn(`WARNING: Got relationships query with ${ids.length} IDs`);

        for (const id of ids) {
            if (typeof id === 'string') {
                const userCache = getUserCache(req.oauth!);
                const user = await userCache.fetchUser(id);
                results.push({
                    id: user.id_str,
                    following: user.following,
                    showing_reblogs: false, // todo
                    notifying: user.notifications,
                    followed_by: user.followed_by,
                    blocking: false, // todo
                    blocked_by: false, // todo
                    muting: false,
                    muting_notifications: false,
                    requested: user.follow_request_sent,
                    domain_blocking: false,
                    endorsed: false,
                    note: ''
                });
            }
        }
    }

    res.send(results);
});

app.get('/api/v1/statuses/:id(\\d+)', async (req, res) => {
    const params = buildParams(true);
    params.id = req.params.id;
    const twreq = await req.oauth!.request('GET', `https://api.twitter.com/2/timeline/conversation/${params.id}.json`, params);
    const conversation = await twreq.json();
    if ('errors' in conversation && conversation.errors.some((e) => e.code === 34)) {
        // Code 34 === tweet does not exist. Respond accordingly.
        res.status(404).send({error: 'Record not found'});
        return;
    }
    const tweet = conversation.globalObjects.tweets[params.id];
    if (twreq.status === 200) {
        res.send(tweetToToot(tweet, conversation.globalObjects));
    } else {
        res.status(twreq.status).send({error: JSON.stringify(conversation.errors)});
    }
});

app.get('/api/v1/statuses/:id(\\d+)/favourited_by', async (req, res) => {
    const variables = {
        "includeTweetImpression": true,
        "includeHasBirdwatchNotes": false,
        "includeEditPerspective": false,
        "tweet_id": req.params.id,
        "includeEditControl": true,
        "includeTweetVisibilityNudge": true
    };
    const features = {
        "unified_cards_ad_metadata_container_dynamic_card_content_query_enabled": true,
    };
    const twreq = await req.oauth!.getGraphQL(`/098IQ5T4TeTVlwtaRQh7Rw/FavoritersTimeline`, variables, features);
    const response = await twreq.json();
    const users = response.data.timeline_response.timeline.instructions
      .find((i) => i['__typename'] === 'TimelineAddEntries')
      .entries
      .map((e) => e.content.content?.userResult.result.legacy)
      .filter((u) => !!u);
    if (twreq.status === 200) {
        res.send(users.map(userToAccount));
    } else {
        res.status(twreq.status).send({error: JSON.stringify(response.errors)});
    }
});

app.get('/api/v1/statuses/:id(\\d+)/reblogged_by', async (req, res) => {
    // NOTE: this endpoint doesn't show quote tweets.
    const variables = {
        "includeTweetImpression": true,
        "includeHasBirdwatchNotes": false,
        "includeEditPerspective": false,
        "tweet_id": req.params.id,
        "includeEditControl": true,
        "includeTweetVisibilityNudge": true
    };
    const features = {
        "unified_cards_ad_metadata_container_dynamic_card_content_query_enabled": true,
    };
    const twreq = await req.oauth!.getGraphQL(`/qYfITpqIDKrPUwJjledDqw/RetweetersTimeline`, variables, features);
    const response = await twreq.json();
    const users = response.data.timeline_response.timeline.instructions
      .find((i) => i['__typename'] === 'TimelineAddEntries')
      .entries
      .map((e) => e.content.content?.userResult.result.legacy)
      .filter((u) => !!u);
    if (twreq.status === 200) {
        res.send(users.map(userToAccount));
    } else {
        res.status(twreq.status).send({error: JSON.stringify(response.errors)});
    }
});

app.get('/api/v1/accounts/:id(\\d+)/followers', async (req, res) => {
    const params = buildParams(true);
    params.user_id = req.params.id;
    params.count = req.body.limit;
    const twreq = await req.oauth!.request('GET', `https://api.twitter.com/1.1/followers/list.json`, params);
    const response = await twreq.json();
    const users = response.users;
    if (twreq.status === 200) {
        res.send(users.map(userToAccount));
    } else {
        res.status(twreq.status).send({error: JSON.stringify(response.errors)});
    }
    res.status(404);
});

app.get('/api/v1/accounts/:id(\\d+)/following', async (req, res) => {
    const params = buildParams(true);
    params.user_id = req.params.id;
    params.count = req.body.limit;
    const twreq = await req.oauth!.request('GET', `https://api.twitter.com/1.1/friends/list.json`, params);
    const response = await twreq.json();
    const users = response.users;
    if (twreq.status === 200) {
        res.send(users.map(userToAccount));
    } else {
        res.status(twreq.status).send({error: JSON.stringify(response.errors)});
    }
    res.status(404);
});

app.get('/api/v1/accounts/familiar_followers', async (req, res) => {
    const params = {};
    params.variables = {
        "include_smart_block": false,
        "includeTweetImpression": true,
        "includeHasBirdwatchNotes": false,
        "includeEditPerspective": false,
        "includeEditControl": true,
        "rest_id": req.body.id,
        "count": req.body.limit,
        "includeTweetVisibilityNudge": true
    }
    params.features = {
        "unified_cards_ad_metadata_container_dynamic_card_content_query_enabled": true,
    };
    const twreq = await req.oauth!.getGraphQL(`/Mj1OuwJog0E8Wo1JKf0zbg/UserFriendsFollowingTimelineQuery`, params.variables, params.features);
    const response = await twreq.json();
    const users = response.data.user.timeline_response.timeline.instructions
      .find((i) => i['__typename'] === 'TimelineAddEntries')
      .entries
      .map((e) => e.content.content?.userResult.result.legacy)
      .filter((u) => !!u);
    if (twreq.status === 200) {
        res.send(users.map(userToAccount));
    } else {
        res.status(twreq.status).send({error: JSON.stringify(response.errors)});
    }
    res.status(404);
});

app.post('/api/v1/accounts/:id(\\d+)/follow', async (req, res) => {
    const params = buildParams(true);
    params.user_id = req.params.id;
    const twreq = await req.oauth!.post(`https://api.twitter.com/1.1/friendships/create.json`, params);
    const response = await twreq.json();
    if (twreq.status === 200) {
        res.send({ id: params.user_id, following: true });
    } else {
        res.status(twreq.status).send({error: JSON.stringify(response.errors)});
    }
});

app.post('/api/v1/accounts/:id(\\d+)/unfollow', async (req, res) => {
    const params = buildParams(true);
    params.user_id = req.params.id;
    const twreq = await req.oauth!.post(`https://api.twitter.com/1.1/friendships/destroy.json`, params);
    const response = await twreq.json();
    if (twreq.status === 200) {
        res.send({ id: params.user_id, following: false });
    } else {
        res.status(twreq.status).send({error: JSON.stringify(response.errors)});
    }
});

app.get('/api/v1/statuses/:id(\\d+)/context', async (req, res) => {
    const id = BigInt(req.params.id as string);

    const params = buildParams(true);
    const twreq = await req.oauth!.request('GET', `https://api.twitter.com/2/timeline/conversation/${id.toString()}.json`, params);
    const conversation = await twreq.json();
    if ('errors' in conversation && conversation.errors.some((e) => e.code === 34)) {
        // Code 34 === tweet does not exist. Respond accordingly.
        res.status(404).send({error: 'Record not found'});
        return;
    }

    const ancestors = [];
    const descendants = [];

    const requestedStatus = conversation.globalObjects.tweets[req.params.id];

    for (const obj of Object.values(conversation.globalObjects.tweets)) {
        const tweet = obj as Record<string, any>;
        const checkID = BigInt(tweet.id_str);
        const isPartOfThisConversation = tweet.conversation_id === requestedStatus.conversation_id;
        if (checkID < id && isPartOfThisConversation)
            ancestors.push(tweetToToot(tweet, conversation.globalObjects));
        else if (checkID > id)
            descendants.push(tweetToToot(tweet, conversation.globalObjects));
    }

    ancestors.sort((a, b) => {
        const aID = BigInt(a.id);
        const bID = BigInt(b.id);
        if (aID < bID)
            return -1;
        if (aID > bID)
            return 1;
        return 0;
    });

    descendants.sort((a, b) => {
        const aID = BigInt(a.id);
        const bID = BigInt(b.id);
        if (aID < bID)
            return -1;
        if (aID > bID)
            return 1;
        return 0;
    });

    res.send({ ancestors, descendants });
});

app.get('/api/v2/search', async (req, res) => {
    // Ivory uses this to resolve an unknown toot
    if (req.body.limit == '1' && req.body.resolve == '1' && req.body.type === 'statuses') {
        const match = /^(.+)\/@([^/]+)\/(\d+)$/.exec(req.body.q as string);
        if (match && match[1] === CONFIG.root) {
            const variables = {
                "includeTweetImpression":true,
                "includeHasBirdwatchNotes":false,
                "includeEditPerspective":false,
                "includeEditControl":true,
                "includeCommunityTweetRelationship":true,
                "rest_id":match[3],
                "includeTweetVisibilityNudge":true,
            };
            const twreq = await req.oauth!.getGraphQL(`/2hxSMXGNMNIocZb8pUn9bQ/TweetResultByIdQuery`, variables);
            const response = await twreq.json();
            if (!response.errors) {
                res.send({accounts: [], hashtags: [], statuses: [graphQLTweetResultToToot(response.data.tweet_result.result)]});
            } else {
                res.status(twreq.status).send({error: JSON.stringify(response.errors)});
            }
        }
    } else if (req.body.type === 'statuses') {
        const params = buildParams(true);
        injectPagingInfo(req.body, params);
        // Don't let the client try and fetch more than 100 tweets at once.
        const safeCount = Math.min(100, parseInt(req.body.limit as string));
        params.count = safeCount.toString();
        params.q = req.body.q;
        params.result_type = 'recent';
        const twreq = await req.oauth!.request('GET', 'https://api.twitter.com/1.1/search/tweets.json', params);
        let tweets;
        tweets = await twreq.json();
        tweets = tweets.statuses;
        const toots = tweets.map(tweetToToot);
        addPageLinksToResponse(new URL(req.originalUrl, CONFIG.root), toots as {id: string}[], res);
        res.send({accounts: [], hashtags: [], statuses: toots});
        return;
    }

    res.sendStatus(404);
});

app.get('/api/v1/timelines/tag/*', async (req, res) => {
    const params = buildParams(true);
    injectPagingInfo(req.body, params);
    // Don't let the client try and fetch more than 100 tweets at once.
    const safeCount = Math.min(100, parseInt(req.body.limit as string));
    params.count = safeCount.toString();
    params.q = '#'+req.params[0];
    params.result_type = 'recent';
    const twreq = await req.oauth!.request('GET', 'https://api.twitter.com/1.1/search/tweets.json', params);
    let tweets;
    tweets = await twreq.json();
    tweets = tweets.statuses;
    const toots = tweets.map(tweetToToot);
    addPageLinksToResponse(new URL(req.originalUrl, CONFIG.root), toots as {id: string}[], res);
    res.send(toots);
});

app.post('/api/v1/statuses', async (req, res) => {
    const text = req.body.status || '';
    let reply_target = req.body.in_reply_to_id;

    if (typeof reply_target === 'number' && req.originalJsonBody) {
        // this is an out-of-spec request from Ivory, so...
        // there's a high chance that JSON.parse has mangled the tweet ID
        const json = new TextDecoder().decode(req.originalJsonBody);
        const match = json.match(/"in_reply_to_id":\s*(\d+)/);
        if (match) {
            console.log(`Received numeric in_reply_to_id: ${reply_target}, replacing with: ${match[1]}`)
            reply_target = match[1];
        } else {
            console.warn('Failed to fix in_reply_to_id number', json);
        }
    }

    /*
    tweet vars from web client: (* = publicly documented)
      *status
      *card_uri
      *attachment_url (for quote tweets)
      *in_reply_to_status_id
      geo
      preview
      conversation_control
      exclusive_tweet_control_options (super follow related)
      trusted_friends_control_options[trusted_friends_list_id] (circles)
      previous_tweet_id (editing)
      semantic_annotation_ids (wtf is this?)
      batch_mode (enum for threading)
      *exclude_reply_user_ids (use with auto_populate_reply_metadata)
      promotedContent
      *media_ids
      media_tags
     */
    const params = {};
    params.variables = {
        "nullcast":false,
        "includeTweetImpression":true,
        "includeHasBirdwatchNotes":false,
        "includeEditPerspective":false,
        "includeEditControl":true,
        "includeCommunityTweetRelationship":false,
        "includeTweetVisibilityNudge":true,
        "tweet_text":text,
    };
    if (reply_target) {
        // Let's not set this for now because Ivory seems to include the @ name in the toot
        //params.auto_populate_reply_metadata = 'true';
        params.variables.reply = {"exclude_reply_user_ids":[],"in_reply_to_tweet_id":reply_target};
    }

    if (req.body.visibility === 'direct') {
        // Fail immediately if someone tries to direct message - we don't support that and probably never will.
        res.status(400).send({error: 'Direct messages are not supported.'});
        return;
    }

    if (req.body.visibility !== 'public') {
        // So Twitter set up Circles in a way that I guess was meant to pave the way for multiple "friends lists"?
        // Cool idea but now that Elon's bought it there's no shot this is ever getting finished. Just makes for more work here.
        const friendsListVariables = {"includeTweetImpression":true,"includeHasBirdwatchNotes":false,"includeEditPerspective":false,"includeEditControl":true};
        const twreq = await req.oauth!.getGraphQL('/LaVEkyIlCyXrD_QXqWkdYA/TrustedFriendsListsQuery', friendsListVariables);
        const response = await twreq.json();
        if (twreq.status === 200) {
            if (response.data.authenticated_user_trusted_friends_lists.length === 0) {
                res.status(400).send({error: 'You must create a trusted friends list (i.e a Twitter Circle) before you can use it.'});
                return;
            }
            const firstList = response.data.authenticated_user_trusted_friends_lists[0];
            params.variables.trusted_friends_control_options = {"trusted_friends_list_id":firstList.rest_id};
        } else {
            res.status(500).send({error: 'Failed to retrieve trusted friend list information. Your post has not been created for your safety.'});
            return;
        }
    }

    const twreq = await req.oauth!.postGraphQL('/f4fzP-emDqiJatuGuzfApg/CreateTweet', params.variables);
    const data = (await twreq.json()).data;
    if (twreq.status === 200) {
        res.send(graphQLTweetResultToToot(data.create_tweet.tweet_result.result));
    } else {
        // TODO: better/more consistent handling of errors...
        res.status(twreq.status).send({error: data.message});
    }
});

app.delete('/api/v1/statuses/:id(\\d+)', async (req, res) => {
    const params = {};
    params.variables = {
        "includeTweetImpression":true,
        "includeHasBirdwatchNotes":false,
        "includeEditPerspective":false,
        "tweet_id": req.params.id,
        "includeEditControl":true,
    };
    const twreq = await req.oauth!.postGraphQL(`/kZyJ4Q1TNsZNByfrGX7Huw/DeleteTweet`, params.variables);
    const tweet = await twreq.json();
    if (twreq.status === 200) {
        // FIXME: Mastodon normally returns the deleted tweet. I have not implemented this because I am lazy.
        res.status(200).send({});
    } else {
        res.status(twreq.status).send({error: JSON.stringify(data?.errors?.[0]?.message)});
    }
});

app.post('/api/v1/statuses/:id(\\d+)/favourite', async (req, res) => {
    const params = buildParams(true);
    params.id = req.params.id;
    const twreq = await req.oauth!.post('https://api.twitter.com/1.1/favorites/create.json', params);
    const tweet = await twreq.json();
    if (twreq.status === 200) {
        res.send(tweetToToot(tweet));
    } else {
        res.status(twreq.status).send({error: JSON.stringify(tweet)});
    }
});

app.post('/api/v1/statuses/:id(\\d+)/unfavourite', async (req, res) => {
    const params = buildParams(true);
    params.id = req.params.id;
    const twreq = await req.oauth!.post('https://api.twitter.com/1.1/favorites/destroy.json', params);
    const tweet = await twreq.json();
    if (twreq.status === 200) {
        res.send(tweetToToot(tweet));
    } else {
        res.status(twreq.status).send({error: JSON.stringify(tweet)});
    }
});

app.post('/api/v1/statuses/:id(\\d+)/reblog', async (req, res) => {
    const params = buildParams(true);
    const twreq = await req.oauth!.post(`https://api.twitter.com/1.1/statuses/retweet/${req.params.id}.json`, params);
    const tweet = await twreq.json();
    if (twreq.status === 200) {
        res.send(tweetToToot(tweet));
    } else {
        res.status(twreq.status).send({error: JSON.stringify(tweet)});
    }
});

app.post('/api/v1/statuses/:id(\\d+)/unreblog', async (req, res) => {
    const params = buildParams(true);
    const twreq = await req.oauth!.post(`https://api.twitter.com/1.1/statuses/unretweet/${req.params.id}.json`, params);
    const tweet = await twreq.json();
    if (twreq.status === 200) {
        res.send(tweetToToot(tweet));
    } else {
        res.status(twreq.status).send({error: JSON.stringify(tweet)});
    }
});

app.get('/api/v1/accounts/search', async (req, res) => {
    // Ivory uses this to resolve a user by name
    if (req.body.limit == '1' && req.body.resolve == '1') {
        const match = /^([^@]+)@([^@]+)$/.exec(req.body.q as string);
        if (match && match[2] === CONFIG.domain) {
            const params = buildParams(true);
            params.screen_name = match[1];
            const twreq = await req.oauth!.request('GET', 'https://api.twitter.com/1.1/users/show.json', params);
            const user = await twreq.json();
            if (twreq.status === 200) {
                res.send([userToAccount(user)]);
            } else {
                res.status(twreq.status).send({error: JSON.stringify(user)});
            }
            return;
        }
    } else {
        const params = buildParams(true);
        injectPagingInfo(req.body, params);
        // Don't let the client try and fetch more than 100 tweets at once.
        const safeCount = Math.min(100, parseInt(req.body.limit as string));
        params.count = safeCount.toString();
        params.q = req.body.q;
        params.result_type = 'recent';
    
        if (params.q.includes('@')) {
            params.q = params.q.match(/^([^@]+)/);
        }
    
        const accReq = await req.oauth!.request('GET', 'https://api.twitter.com/1.1/users/search.json', params);
        let accounts;
        accounts = await accReq.json();
        accounts = accounts.map(userToAccount);
        addPageLinksToResponse(new URL(req.originalUrl, CONFIG.root), accounts as {id: string}[], res);
        res.send(accounts);
    }

    res.sendStatus(404);
});

app.listen(8000);
