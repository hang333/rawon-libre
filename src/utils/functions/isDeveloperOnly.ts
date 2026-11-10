import { type Command } from "@sapphire/framework";

/**
 * Whether a command is reserved for the bot's developers.
 *
 * A command says so in one of two ways: the `devOnly` option, or the framework's
 * `DevOnly` precondition. Preconditions are only evaluated by the framework's
 * own command pipeline, which this bot does not use: prefix commands and slash
 * commands are both dispatched by hand. Whoever dispatches a command therefore
 * has to ask this first, or a command guarded by the precondition alone runs
 * for everybody.
 */
export function isDeveloperOnly(command: Command): boolean {
    const options = command.options as Command.Options & { devOnly?: boolean };
    if (options.devOnly === true) {
        return true;
    }

    const preconditions: unknown[] = Array.isArray(options.preconditions)
        ? (options.preconditions as unknown[]).flat(Number.POSITIVE_INFINITY)
        : [];

    return preconditions.some(
        (entry) =>
            entry === "DevOnly" ||
            (typeof entry === "object" &&
                entry !== null &&
                (entry as { name?: unknown }).name === "DevOnly"),
    );
}
