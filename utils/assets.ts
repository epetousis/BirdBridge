import {CONFIG} from "../config.ts";

export const BLUE_VERIFIED_EMOJI = {
    shortcode: 'blue_verified',
    url: new URL('/static/blue_verified.png', CONFIG.root).toString(),
    static_url: new URL('/static/blue_verified.png', CONFIG.root).toString(),
    visible_in_picker: false,
    category: 'Icons'
};
export const VERIFIED_EMOJI = {
    shortcode: 'verified',
    url: new URL('/static/verified.png', CONFIG.root).toString(),
    static_url: new URL('/static/verified.png', CONFIG.root).toString(),
    visible_in_picker: false,
    category: 'Icons'
};
export const PISS_VERIFIED_EMOJI = {
    shortcode: 'piss_verified',
    url: new URL('/static/piss_verified.png', CONFIG.root).toString(),
    static_url: new URL('/static/piss_verified.png', CONFIG.root).toString(),
    visible_in_picker: false,
    category: 'Icons'
};

export const IMAGE_1PX = new URL('/static/1px.png', CONFIG.root).toString();
