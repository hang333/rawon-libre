/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import { PermissionFlagsBits, type SlashCommandBuilder } from "discord.js";
import i18n from "../../config/index.js";
import { type Rawon } from "../../structures/Rawon.js";
import { inVC, sameVC, validVC } from "../../utils/decorators/MusicUtil.js";
import { type PlayCommand } from "./PlayCommand.js";

/**
 * `play`, except that what it adds goes to the front of the queue instead of
 * the end. Everything about resolving the request is `play`'s own.
 */
@ApplyOptions<Command.Options>({
    name: "playnext",
    aliases: ["pn", "playtop", "pt"],
    description: i18n.__("commands.music.playNext.description"),
    detailedDescription: { usage: i18n.__("commands.music.playNext.usage") },
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
            .setName(opts.name ?? "playnext")
            .setDescription(opts.description ?? i18n.__("commands.music.playNext.description"))
            .addStringOption((opt) =>
                opt
                    .setName("query")
                    .setDescription(i18n.__("commands.music.play.slashQueryDescription"))
                    // Required for the same reason as on `play`.
                    .setRequired(true),
            )
            .addAttachmentOption((opt) =>
                opt
                    .setName("file")
                    .setDescription(i18n.__("commands.music.play.slashFileDescription"))
                    .setRequired(false),
            ) as SlashCommandBuilder;
    },
})
export class PlayNextCommand extends ContextCommand {
    @inVC
    @validVC
    @sameVC
    public async contextRun(ctx: CommandContext): Promise<void> {
        const play = (ctx.client as Rawon).commands.get("play") as unknown as
            | PlayCommand
            | undefined;

        await play?.enqueue(ctx, { next: true, commandName: this.options.name });
    }
}
