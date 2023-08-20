export interface Config {
    headers: Record<string, string>,
    bridge_password: string,
    bridge_secret: string,
    consumer_key: string,
    consumer_secret: string,
    max_context_pages?: number,
    pagination_safety_buffer?: number,
    /** Controls whether to block Twitter Blue users who you do not follow.
     * Business accounts are still returned.
     */
    block_the_blue?: boolean,
    root: string,
    domain: string
}

export const CONFIG: Config = JSON.parse(Deno.readTextFileSync('bridge_config.json'));
