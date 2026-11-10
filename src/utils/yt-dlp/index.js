import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import nodePath from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import got from "got";

const run = promisify(execFile);

const suffix = process.platform === "win32" ? ".exe" : (
    process.platform === "darwin" ? "_macos" : ""
);
const filename = `yt-dlp${suffix}`;
const scriptsPath = nodePath.resolve(process.cwd(), "cache", "scripts");
const exePath = nodePath.resolve(scriptsPath, filename);
// Where a download waits until it has been checked. It keeps the platform's
// suffix so that it can be run for that check.
const stagedPath = nodePath.resolve(scriptsPath, `yt-dlp.new${suffix}`);

const RELEASES_URL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases?per_page=10";
// A release is taken up on its own only once it has been out this long. A day
// is enough for a broken or tampered build to be noticed and withdrawn; when a
// fix is needed sooner, a developer can ask for the newest release by hand.
const MIN_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// The binary unpacks itself before it can answer, which takes a few seconds.
const VERSION_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

let autoUpdateTimer = null;
const updateState = { busy: false, lastCheckAt: null, lastResult: null };

let cookiesManagerRef = null;

export function setCookiesManager(manager) {
    cookiesManagerRef = manager;
}

export function getCookiesManager() {
    return cookiesManagerRef;
}

function args(url, options, cookiesPath) {
    const optArgs = ["--js-runtimes", "node"];

    optArgs.push(
        ...Object.entries(options)
            .flatMap(([key, val]) => {
                const flag = key.replaceAll(/[A-Z]/gu, (ms) => `-${ms.toLowerCase()}`);
                return [
                    `--${(typeof val === "boolean") && !val ? "no-" : ""}${flag}`,
                    typeof val === "boolean" ? "" : val,
                ];
            })
            .filter(Boolean),
    );

    const effectiveCookiesPath = cookiesPath ?? cookiesManagerRef?.getCurrentCookiePath();
    const useCookies = effectiveCookiesPath && existsSync(effectiveCookiesPath);
    
    if (useCookies) {
        const tempCookiesPath = effectiveCookiesPath + ".ytdlp-tmp";
        try {
            copyFileSync(effectiveCookiesPath, tempCookiesPath);
            optArgs.push("--cookies", tempCookiesPath);
        } catch {
            optArgs.push("--cookies", effectiveCookiesPath);
        }
    }

    const extractorArgs = cookiesManagerRef?.getExtractorArgs?.();
    if (extractorArgs) {
        optArgs.push("--extractor-args", extractorArgs);
    }

    return [url, ...optArgs];
}

function json(str) {
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}

export function isBotDetectionError(errorMessage) {
    const lowerError = (errorMessage ?? "").toLowerCase();
    if (lowerError.includes("age-restricted")) return false;
    return (
        lowerError.includes("sign in to confirm you're not a bot") ||
        lowerError.includes("sign in to confirm") ||
        lowerError.includes("please sign in") ||
        lowerError.includes("http error 429") ||
        lowerError.includes("error 429") ||
        lowerError.includes("too many requests") ||
        (lowerError.includes("this video is unavailable") && lowerError.includes("429")) ||
        lowerError.includes("login required")
    );
}

export function isAgeRestrictedError(errorMessage) {
    const lowerError = (errorMessage ?? "").toLowerCase();
    if (lowerError.includes("age restricted content")) return true;
    return (
        lowerError.includes("age-restricted") &&
        (lowerError.includes("sign in") || lowerError.includes("confirm"))
    );
}

/**
 * Order two yt-dlp versions. They are dates with an optional build number
 * (2025.12.08, 2025.12.08.1), so they compare part by part as numbers.
 */
export function compareVersions(a, b) {
    const left = String(a).replace(/^v/, "").split(".").map(Number);
    const right = String(b).replace(/^v/, "").split(".").map(Number);

    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * The releases this platform can run, newest first, reduced to what the
 * updater needs. Drafts and pre-releases are never candidates.
 */
export function usableReleases(releases) {
    return (Array.isArray(releases) ? releases : [])
        .filter(release => release && !release.draft && !release.prerelease)
        .map(release => ({
            version: String(release.tag_name ?? "").replace(/^v/, ""),
            publishedAt: Date.parse(release.published_at),
            url: release.assets?.find(asset => asset.name === filename)?.browser_download_url ?? null,
        }))
        .filter(release => release.version && release.url && Number.isFinite(release.publishedAt))
        .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * The release to be on. Left to itself the updater takes the newest one that
 * has been out for the minimum age; `force` takes the newest there is.
 */
export function selectRelease(releases, { force = false, now = Date.now(), minAgeMs = MIN_RELEASE_AGE_MS } = {}) {
    if (force) return releases[0] ?? null;
    return releases.find(release => now - release.publishedAt >= minAgeMs) ?? null;
}

async function fetchReleases() {
    return usableReleases(await got.get(RELEASES_URL, { timeout: { request: 15_000 } }).json());
}

/** The version of the given binary, or null when it is missing or will not run. */
async function versionOf(binary) {
    if (!existsSync(binary)) return null;
    try {
        const { stdout } = await run(binary, ["--version"], { timeout: VERSION_TIMEOUT_MS, windowsHide: true });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

export async function getInstalledVersion() {
    return versionOf(exePath);
}

/**
 * Put a release in place of the current binary. The download is run once to
 * confirm that it starts and is the version it claims to be, and only then
 * renamed over the old file, so that a truncated or broken download never
 * becomes the binary the bot plays with. Renaming rather than overwriting also
 * leaves a yt-dlp that is running at that moment undisturbed.
 */
async function installRelease(release) {
    mkdirSync(scriptsPath, { recursive: true });
    rmSync(stagedPath, { force: true });

    try {
        await pipeline(
            got.stream(release.url, { timeout: { request: DOWNLOAD_TIMEOUT_MS } }),
            createWriteStream(stagedPath),
        );
        chmodSync(stagedPath, 0o755);

        const reported = await versionOf(stagedPath);
        if (reported === null) {
            throw new Error(`the downloaded ${release.version} does not run`);
        }
        if (compareVersions(reported, release.version) !== 0) {
            throw new Error(`the download reports version ${reported}, not ${release.version}`);
        }

        renameSync(stagedPath, exePath);
    } catch (err) {
        rmSync(stagedPath, { force: true });
        // Windows will not replace a program that is running.
        if (["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
            throw new Error("yt-dlp is in use and could not be replaced");
        }
        throw err;
    }
}

/**
 * Compare the installed binary with the published releases and, unless
 * `dryRun` is set, install the one it should be on.
 *
 * The result's `status` is "updated" when a release was installed, "available"
 * when a dry run found one to install, "waiting" when the only newer release
 * is too recent to be taken up yet, "current" when there is nothing newer,
 * "busy" when another check is still running, and "failed" with an `error`.
 */
export async function checkForUpdate({ force = false, dryRun = false } = {}) {
    if (updateState.busy) {
        return { status: "busy", current: null, target: null, latest: null, latestPublishedAt: null, eligibleAt: null, error: null };
    }
    updateState.busy = true;

    const result = { status: "failed", current: null, target: null, latest: null, latestPublishedAt: null, eligibleAt: null, error: null };
    try {
        result.current = await getInstalledVersion();

        const releases = await fetchReleases();
        const latest = releases[0] ?? null;
        const target = selectRelease(releases, { force });

        result.latest = latest?.version ?? null;
        result.latestPublishedAt = latest?.publishedAt ?? null;
        result.eligibleAt = latest ? latest.publishedAt + MIN_RELEASE_AGE_MS : null;

        const isNewer = release => release !== null &&
            (result.current === null || compareVersions(release.version, result.current) > 0);

        if (!isNewer(target)) {
            result.status = isNewer(latest) ? "waiting" : "current";
        } else if (dryRun) {
            result.status = "available";
            result.target = target.version;
        } else {
            await installRelease(target);
            result.status = "updated";
            result.target = target.version;
        }
    } catch (err) {
        result.status = "failed";
        result.error = err.message;
    } finally {
        updateState.busy = false;
    }

    if (!dryRun) {
        updateState.lastCheckAt = Date.now();
        updateState.lastResult = result;
    }
    return result;
}

export function getUpdateState() {
    return {
        ...updateState,
        minReleaseAgeMs: MIN_RELEASE_AGE_MS,
        checkIntervalMs: UPDATE_CHECK_INTERVAL_MS,
        running: autoUpdateTimer !== null,
    };
}

/**
 * Make sure there is a yt-dlp to run before the bot starts. A first install
 * takes the newest release that has been out for the minimum age, or failing
 * that the newest there is, since having none is not an option. An existing
 * binary is brought up to date by the same rule the scheduled check follows.
 */
export async function downloadExecutable() {
    if (existsSync(exePath)) {
        const result = await checkForUpdate();
        if (result.status === "updated") {
            console.info(`[INFO] Yt-dlp updated from ${result.current ?? "an unknown version"} to ${result.target}.`);
        } else if (result.status === "failed") {
            console.warn(`[WARN] Yt-dlp update check failed, using existing binary: ${result.error}`);
        }
    } else {
        console.info("[INFO] Downloading yt-dlp...");
        const releases = await fetchReleases();
        const release = selectRelease(releases) ?? selectRelease(releases, { force: true });
        if (release === null) {
            throw new Error("No yt-dlp release is available for this platform.");
        }

        await installRelease(release);
        console.info(`[INFO] Yt-dlp downloaded (release: ${release.version}).`);
    }

    const version = await getInstalledVersion();
    if (version !== null) {
        console.info(`[INFO] Using yt-dlp version: ${version}`);
    }
}

export const exec = (url, options = {}, spawnOptions = {}, cookiesPath = null) => spawn(exePath, args(url, options, cookiesPath), {
    windowsHide: true,
    ...spawnOptions
});

/**
 * Check for a release to take up once an hour. Nothing waits for the bot to be
 * idle: an update is renamed into place, which does not disturb a yt-dlp that
 * is running, and where the system refuses that the next check tries again.
 */
export function startAutoUpdater(client) {
    if (autoUpdateTimer) return;

    const logger = client?.logger ?? console;
    logger.info("[yt-dlp AutoUpdater] Checking for updates every hour; a release is installed once it has been out for 24 hours.");

    autoUpdateTimer = setInterval(async () => {
        const result = await checkForUpdate();

        if (result.status === "updated") {
            logger.info(`[yt-dlp AutoUpdater] Updated from ${result.current ?? "an unknown version"} to ${result.target}.`);
        } else if (result.status === "failed") {
            logger.warn(`[yt-dlp AutoUpdater] Update check failed: ${result.error}`);
        }
    }, UPDATE_CHECK_INTERVAL_MS);
}

export function stopAutoUpdater() {
    if (autoUpdateTimer) {
        clearInterval(autoUpdateTimer);
        autoUpdateTimer = null;
        console.info("[yt-dlp AutoUpdater] Stopped.");
    }
}

export default async function ytdl(url, options = {}, spawnOptions = {}, cookiesPath = null) {
    const result = await ytdlOnce(url, options, spawnOptions, cookiesPath);
    return result;
}

async function ytdlOnce(url, options = {}, spawnOptions = {}, cookiesPath = null) {
    const proc = exec(url, options, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] }, cookiesPath);
    let data = "";
    let stderrData = "";

    await new Promise((resolve, reject) => {
        if (proc.stderr) {
            proc.stderr.on("data", (chunk) => {
                stderrData += chunk.toString();
            });
        }

        proc.on("error", reject)
            .on("close", (code) => {
                if (code !== 0 && stderrData && isBotDetectionError(stderrData)) {
                    reject(new Error(`Sign in to confirm you're not a bot. URL: ${url}`));
                    return;
                }
                if (code !== 0 && stderrData && isAgeRestrictedError(stderrData)) {
                    reject(new Error("Age restricted content."));
                    return;
                }
                if (code !== 0) {
                    reject(new Error(`yt-dlp process exited with code ${code}: ${stderrData}`));
                    return;
                }
                resolve(code);
            })
            .stdout.on("data", (chunk) => (data += chunk));
    });
    return json(data);
}
