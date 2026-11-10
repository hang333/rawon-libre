import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { type ClientPresenceStatus } from "discord.js";
import { parse } from "dotenv";
import { type EnvActivityTypes, type PresenceData } from "../typings/index.js";
import { parseEnvValue } from "../utils/functions/parseEnvValue.js";

const envFiles = ["dev.env", ".env"];

const existingToken = process.env.DISCORD_TOKEN;
for (const envFile of envFiles) {
    const envPath = path.resolve(process.cwd(), envFile);
    if (existsSync(envPath)) {
        const parsed = parse(readFileSync(envPath));
        for (const [key, val] of Object.entries(parsed)) {
            if (key === "DISCORD_TOKEN" && existingToken && !existingToken.includes(",")) {
                continue;
            }
            process.env[key] = val;
        }
    }
}

if (existingToken && !process.env.DISCORD_TOKEN?.includes(",")) {
    process.env.DISCORD_TOKEN = existingToken;
}

const toCapitalCase = (text: string): string => {
    if (text === "") {
        return "";
    }
    return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
};

const formatLocale = (locale: string | undefined): string => {
    if ((locale?.length ?? 0) === 0) {
        return "en-US";
    }
    const parts = locale?.toLowerCase().split("-") ?? [];
    if (parts.length === 2) {
        parts[1] = parts[1].toUpperCase();
    }
    return parts.join("-");
};

const rawTokens = process.env.DISCORD_TOKEN ?? "";
const hasComma = rawTokens.includes(",");
const tokenArray = hasComma
    ? rawTokens
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
    : rawTokens.trim().length > 0
      ? [rawTokens.trim()]
      : [];

export const discordTokens: string[] = tokenArray;
export const discordToken = tokenArray[0] ?? "";
export const isMultiBot = tokenArray.length > 1 && hasComma;

export const clientId = process.env.SPOTIFY_CLIENT_ID ?? "";
export const clientSecret = process.env.SPOTIFY_CLIENT_SECRET ?? "";

const computedIsDev = process.env.NODE_ENV?.toLowerCase() === "development";
export const isDev = computedIsDev;
export const isProd = !computedIsDev;

export const mainPrefix = isDev ? "d!" : (process.env.MAIN_PREFIX ?? "") || "!";
export const mainServer = parseEnvValue(process.env.MAIN_SERVER ?? "");
export const devs: string[] = parseEnvValue(process.env.DEVS ?? "");
export const lang = formatLocale(process.env.LOCALE) || "en-US";

export const presenceData: PresenceData = {
    activities: parseEnvValue(process.env.ACTIVITIES ?? "").map((x, i) => ({
        name: x,
        type: (toCapitalCase(parseEnvValue(process.env.ACTIVITY_TYPES ?? "")[i]) ||
            "Playing") as EnvActivityTypes,
    })),
    status: ["online"] as ClientPresenceStatus[],
    interval: 60_000,
};

export const enablePrefix = process.env.ENABLE_PREFIX?.toLowerCase() !== "no";
export const enableSlashCommand = process.env.ENABLE_SLASH_COMMAND?.toLowerCase() !== "no";
export const enableSharding = process.env.ENABLE_SHARDING?.toLowerCase() === "yes";

const rawDevtoolsPort = Number(process.env.DEVTOOLS_PORT);
export const devtoolsPort =
    Number.isFinite(rawDevtoolsPort) && rawDevtoolsPort > 0 ? rawDevtoolsPort : 3000;

// Whether the login command reaches its browser through a Cloudflare quick
// tunnel instead of the DevTools port. Off unless asked for: it runs
// cloudflared, fetching it on first use, and puts the login browser on a
// public address for as long as a login is in progress.
export const devtoolsTunnel = process.env.DEVTOOLS_TUNNEL?.trim().toLowerCase() === "yes";

export const debugMode = process.env.DEBUG_MODE?.toLowerCase() === "yes";

// Where a plain-text search looks first. Anything other than "youtube" keeps the
// default, so a typo cannot leave the bot unable to search.
export type SearchProvider = "youtube" | "youtube-music";
export const searchProvider: SearchProvider =
    process.env.SEARCH_PROVIDER?.trim().toLowerCase() === "youtube" ? "youtube" : "youtube-music";

// Whether a search that finds nothing on YouTube, or a Spotify track with no
// match there, is looked for on Bilibili before it is given up. Only "no" turns
// it off.
export const bilibiliFallback = process.env.BILIBILI_FALLBACK?.trim().toLowerCase() !== "no";

const baseUrlFromEnv = (value: string | undefined): string =>
    (value ?? "").trim().replace(/\/+$/u, "");

// Every outside host the bot talks to on the operator's behalf is named here, so
// none of them is a fixed dependency of the fork.

// Only contacted when a lyrics token is set; LRCLIB covers lyrics without one.
export const stegripeApiUrl =
    baseUrlFromEnv(process.env.STEGRIPE_API_URL) || "https://api.stegripe.org";
export const stegripeApiLyricsToken = process.env.STEGRIPE_API_LYRICS_TOKEN ?? "";

// A hastebin-compatible paste server for eval output too long for an embed.
// Empty means the output is attached to the reply as a file instead.
export const hasteUrl = baseUrlFromEnv(process.env.HASTE_URL);

// Where icon.png, information.png and question_mark.png are served from.
// Empty means the bot's own avatar stands in for all three.
export const assetBaseUrl = baseUrlFromEnv(process.env.ASSET_BASE_URL);
