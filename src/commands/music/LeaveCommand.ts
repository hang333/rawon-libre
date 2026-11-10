/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import { PermissionFlagsBits, type SlashCommandBuilder } from "discord.js";
import i18n from "../../config/index.js";
import { type Rawon } from "../../structures/Rawon.js";

/**
 * `stop` under the name people reach for first. Stopping already empties the
 * queue and leaves the voice channel, so this hands over to it rather than
 * keeping a second copy of the same steps; `stop` runs its own checks.
 */
@ApplyOptions<Command.Options>({
    name: "leave",
    aliases: [],
    description: i18n.__("commands.music.leave.description"),
    detailedDescription: { usage: "{prefix}leave" },
    requiredClientPermissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
    ],
    chatInputCommand(
        builder: Parameters<NonNullable<Command.Options["chatInputCommand"]>>[0],
        opts: Parameters<NonNullable<Command.Options["chatInputCommand"]>>[1],
    ): SlashCommandBuilder {
        return builder
            .setName(opts.name ?? "leave")
            .setDescription(
                opts.description ?? i18n.__("commands.music.leave.description"),
            ) as SlashCommandBuilder;
    },
})
export class LeaveCommand extends ContextCommand {
    public async contextRun(ctx: CommandContext): Promise<void> {
        const stop = (ctx.client as Rawon).commands.get("stop") as
            | { contextRun?: (ctx: CommandContext) => Promise<unknown> }
            | undefined;

        await stop?.contextRun?.(ctx);
    }
}
