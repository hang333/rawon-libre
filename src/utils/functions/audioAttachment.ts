import { type Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import { type Attachment } from "discord.js";
import prism from "prism-media";
import { type Song } from "../../typings/index.js";

const PLAYABLE_EXTENSIONS = new Set([
    "3gp",
    "aac",
    "aif",
    "aiff",
    "flac",
    "m4a",
    "m4b",
    "mka",
    "mkv",
    "mov",
    "mp3",
    "mp4",
    "oga",
    "ogg",
    "opus",
    "wav",
    "weba",
    "webm",
    "wma",
]);

const PROBE_TIMEOUT_MS = 8_000;
const DURATION_PATTERN = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/u;

function getExtension(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/**
 * Whether an uploaded file is something ffmpeg can be expected to play. Discord
 * reports a content type for most uploads; the extension covers the ones it does
 * not recognise.
 */
export function isPlayableAttachment(attachment: Attachment): boolean {
    const contentType = attachment.contentType?.toLowerCase() ?? "";
    if (contentType.startsWith("audio/") || contentType.startsWith("video/")) {
        return true;
    }

    return PLAYABLE_EXTENSIONS.has(getExtension(attachment.name));
}

export function getPlayableAttachments(attachments: Iterable<Attachment>): Attachment[] {
    return [...attachments].filter((attachment) => isPlayableAttachment(attachment));
}

function getAttachmentTitle(attachment: Attachment): string {
    // Discord swaps spaces for underscores in the stored file name and keeps the
    // name as typed in `title` when the two differ.
    if ((attachment.title?.length ?? 0) > 0) {
        return attachment.title as string;
    }

    const dot = attachment.name.lastIndexOf(".");
    const baseName = dot > 0 ? attachment.name.slice(0, dot) : attachment.name;
    const title = baseName.replaceAll("_", " ").trim();
    return title.length > 0 ? title : attachment.name;
}

/**
 * Read a media file's length, in whole seconds, from the header ffmpeg prints for
 * it. Resolves to 0 when it cannot be told: no ffmpeg, an unreachable file, a
 * container that does not record a length, or no answer within the timeout.
 */
export async function probeDuration(url: string): Promise<number> {
    let command: string;
    try {
        command = prism.FFmpeg.getInfo().command;
    } catch {
        return 0;
    }

    return new Promise<number>((resolve) => {
        // With no output named, ffmpeg describes the input on stderr and exits.
        const proc = spawn(command, ["-hide_banner", "-i", url], {
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });

        let stderr = "";
        let settled = false;
        const finish = (seconds: number): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            proc.kill("SIGKILL");
            resolve(seconds);
        };
        const timer = setTimeout(() => finish(0), PROBE_TIMEOUT_MS);

        const readDuration = (): number => {
            const match = DURATION_PATTERN.exec(stderr);
            if (!match) {
                return 0;
            }

            const seconds =
                Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number.parseFloat(match[3]);
            return Number.isFinite(seconds) ? Math.round(seconds) : 0;
        };

        proc.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
            const seconds = readDuration();
            if (seconds > 0) {
                finish(seconds);
            }
        });
        proc.once("error", () => finish(0));
        proc.once("close", () => finish(readDuration()));
    });
}

/**
 * Turn uploaded files into queue entries. The URL is Discord's own link to the
 * upload: it is signed, expires after about a day, and dies with the message it
 * was posted in.
 */
export async function attachmentsToSongs(attachments: Attachment[]): Promise<Song[]> {
    return Promise.all(
        attachments.map(async (attachment): Promise<Song> => {
            // Only voice messages come with a length; everything else is probed.
            const reported = Math.round(attachment.duration ?? 0);

            return {
                duration: reported > 0 ? reported : await probeDuration(attachment.url),
                id: attachment.id,
                thumbnail: "",
                title: getAttachmentTitle(attachment),
                url: attachment.url,
            };
        }),
    );
}
