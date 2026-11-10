import { type Buffer } from "node:buffer";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { clearTimeout, setTimeout } from "node:timers";
import got from "got";

/**
 * A Cloudflare quick tunnel: a public https address on trycloudflare.com that
 * forwards to a local port, made by running `cloudflared` with no account and
 * no configuration. It lasts as long as the process does.
 *
 * The address is random and is the only thing standing between the internet
 * and whatever the port serves, so it must be treated as a secret and the
 * tunnel kept open no longer than it is needed.
 */

const RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";
const TUNNEL_ADDRESS = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u;
const CONNECTED = /Registered tunnel connection/u;

/** How long cloudflared gets to report a working tunnel. */
const START_TIMEOUT_MS = 45_000;
/**
 * The address is printed before the tunnel is connected, and a link opened in
 * between answers with an error page. Should the connection never be reported
 * in the words expected here, the address is handed out after this long anyway.
 */
const CONNECT_GRACE_MS = 8_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** The release file for this machine, or null where there is none to fetch. */
function releaseAsset(): string | null {
    const arch = { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" }[process.arch as string];
    if (arch === undefined) {
        return null;
    }
    if (process.platform === "linux") {
        return `cloudflared-linux-${arch}`;
    }
    if (process.platform === "win32" && (arch === "amd64" || arch === "386")) {
        return `cloudflared-windows-${arch}.exe`;
    }

    // macOS releases are archives; there, cloudflared has to be installed.
    return null;
}

/**
 * Where to run cloudflared from. One that is already installed is the
 * operator's choice and is used as it is; otherwise the release for this
 * machine is fetched once into the cache directory, next to yt-dlp.
 */
async function resolveBinary(): Promise<string> {
    const installed = spawnSync("cloudflared", ["--version"], {
        stdio: "ignore",
        windowsHide: true,
    });
    if (installed.status === 0) {
        return "cloudflared";
    }

    const asset = releaseAsset();
    if (asset === null) {
        throw new Error(
            `cloudflared is not installed, and there is no download for ${process.platform}/${process.arch}`,
        );
    }

    const directory = path.resolve(process.cwd(), "cache", "scripts");
    const binary = path.join(
        directory,
        process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
    );
    if (existsSync(binary)) {
        return binary;
    }

    mkdirSync(directory, { recursive: true });
    // Written under another name first, so that an interrupted download is
    // never mistaken for the program.
    const partial = `${binary}.download`;
    try {
        await pipeline(
            got.stream(`${RELEASE_BASE}/${asset}`, { timeout: { request: DOWNLOAD_TIMEOUT_MS } }),
            createWriteStream(partial),
        );
        chmodSync(partial, 0o755);
        renameSync(partial, binary);
    } catch (error) {
        rmSync(partial, { force: true });
        throw new Error(`could not download cloudflared: ${(error as Error).message}`);
    }

    return binary;
}

export class QuickTunnel {
    private child: ChildProcess | null = null;

    public constructor() {
        // A tunnel must not outlive the bot that opened it.
        process.once("exit", () => this.stop());
    }

    public get running(): boolean {
        return this.child !== null;
    }

    /**
     * Open a tunnel to `port` on this machine and return its public address,
     * such as `https://some-random-words.trycloudflare.com`.
     */
    public async start(port: number): Promise<string> {
        this.stop();

        const binary = await resolveBinary();
        const child = spawn(
            binary,
            [
                "tunnel",
                "--no-autoupdate",
                "--url",
                `http://127.0.0.1:${port}`,
                // Chromium's debugging endpoint turns away requests addressed
                // to anything but localhost or an IP address.
                "--http-host-header",
                "localhost",
            ],
            { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        this.child = child;

        return new Promise<string>((resolve, reject) => {
            let output = "";
            let address: string | null = null;
            let grace: NodeJS.Timeout | null = null;
            let settled = false;

            const settle = (outcome: Error | string): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(deadline);
                if (grace !== null) {
                    clearTimeout(grace);
                }

                if (typeof outcome === "string") {
                    resolve(outcome);
                    return;
                }

                if (this.child === child) {
                    this.stop();
                }
                reject(outcome);
            };

            const deadline = setTimeout(() => {
                settle(new Error("cloudflared did not report a tunnel in time"));
            }, START_TIMEOUT_MS);

            const read = (chunk: Buffer): void => {
                output = (output + chunk.toString()).slice(-8_000);

                if (address === null) {
                    address = TUNNEL_ADDRESS.exec(output)?.[0] ?? null;
                    if (address !== null) {
                        const found = address;
                        grace = setTimeout(() => settle(found), CONNECT_GRACE_MS);
                    }
                }
                if (address !== null && CONNECTED.test(output)) {
                    settle(address);
                }
            };

            child.stdout?.on("data", read);
            child.stderr?.on("data", read);
            child.once("error", (error) => settle(error));
            child.once("exit", (code) => {
                if (this.child === child) {
                    this.child = null;
                }

                const lastLine = output.trim().split("\n").at(-1) ?? "";
                settle(new Error(`cloudflared exited with code ${code}. ${lastLine}`.trim()));
            });
        });
    }

    public stop(): void {
        const child = this.child;
        this.child = null;

        if (child !== null && child.exitCode === null) {
            try {
                child.kill();
            } catch {}
        }
    }
}
