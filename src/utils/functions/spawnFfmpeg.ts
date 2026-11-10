import { type ChildProcess, spawn } from "node:child_process";
import { type Readable, type Writable } from "node:stream";
import prism from "prism-media";

/**
 * ffmpeg as a plain child process, with real pipes for its input and output.
 *
 * prism-media's own FFmpeg class is a Duplex that borrows the `write` and
 * `read` methods of the child's pipes instead of implementing a stream. That
 * breaks on Node 26: when the source already holds data at the moment it is
 * piped, as a download that has been running for a moment does, that data is
 * handed to the destination through its internals rather than through the
 * public `write`, and the class fails with "The _write() method is not
 * implemented". @discordjs/voice uses the same class to decode an "arbitrary"
 * input, so what is decoded here is handed over as raw PCM, which needs no
 * ffmpeg of its own.
 */
export type FfmpegProcess = {
    /** The audio ffmpeg produces, in whatever format the arguments ask for. */
    output: Readable;
    process: ChildProcess;
};

export type FfmpegHandlers = {
    /** A stream to feed ffmpeg, when the arguments read from standard input. */
    input?: Readable;
    onError(error: unknown): void;
    onClose?(code: number | null): void;
    onStderr?(text: string): void;
};

/** Error codes a pipe gives when the other end has simply gone away. */
const CLOSED_PIPE = new Set([
    "EPIPE",
    "EOF",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_WRITE_AFTER_END",
    "ERR_STREAM_PREMATURE_CLOSE",
]);
const isClosedPipe = (error: unknown): boolean =>
    CLOSED_PIPE.has((error as NodeJS.ErrnoException | null)?.code ?? "");

/**
 * Run ffmpeg with the given arguments, writing to its standard output.
 * The process is killed as soon as nothing reads that output any more.
 */
export function spawnFfmpeg(args: string[], handlers: FfmpegHandlers): FfmpegProcess {
    const child = spawn(prism.FFmpeg.getInfo().command, [...args, "pipe:1"], {
        windowsHide: true,
        stdio: [handlers.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const output = child.stdout as Readable;
    const stdin = child.stdin as Writable | null;

    child.once("error", (error) => handlers.onError(error));
    child.once("close", (code) => handlers.onClose?.(code));
    // The reader letting go of the audio part-way is how every skip and stop
    // looks from here, and is reported as a premature close. It is not a fault.
    output.on("error", (error) => {
        if (!isClosedPipe(error)) {
            handlers.onError(error);
        }
    });

    // Always drained, so that a talkative ffmpeg cannot fill the pipe and stall.
    child.stderr?.on("data", (chunk: unknown) => handlers.onStderr?.(String(chunk)));

    // Whoever reads the audio decides when it is over: a skip, a seek and a
    // stop all end by closing this stream. ffmpeg then has nobody to decode for.
    output.once("close", () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
        }
    });

    if (handlers.input && stdin) {
        const input = handlers.input;

        // ffmpeg closing its input before the source is done is what the above
        // looks like from this side, not a failure of the source.
        stdin.on("error", (error) => {
            if (!isClosedPipe(error)) {
                handlers.onError(error);
            }
        });
        // A source that fails leaves ffmpeg waiting for more: let it finish
        // with what it was given.
        input.once("error", () => stdin.end());
        input.pipe(stdin);
    }

    return { output, process: child };
}
