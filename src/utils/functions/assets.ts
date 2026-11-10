import { type Client } from "discord.js";
import { assetBaseUrl } from "../../config/env.js";

const ASSET_FILES = {
    icon: "icon.png",
    information: "information.png",
    questionMark: "question_mark.png",
} as const;

export type AssetName = keyof typeof ASSET_FILES;

/**
 * URL of one of the small images embeds decorate themselves with.
 *
 * With ASSET_BASE_URL set they are served from there. Without it the bot's own
 * avatar stands in, so a fresh install shows something sensible and does not
 * lean on a host the operator has no say over.
 */
export function assetUrl(client: Client, name: AssetName): string | undefined {
    if (assetBaseUrl.length > 0) {
        return `${assetBaseUrl}/${ASSET_FILES[name]}`;
    }

    return client.user?.displayAvatarURL({ extension: "png", size: 256 });
}
