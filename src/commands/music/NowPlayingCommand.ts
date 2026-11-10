/** biome-ignore-all lint/style/useNamingConvention: disable naming convention rule for this file */
import { ApplyOptions } from "@sapphire/decorators";
import { type Command } from "@sapphire/framework";
import { type CommandContext, ContextCommand } from "@stegripe/command-context";
import {
    BaseInteraction,
    type CommandInteraction,
    PermissionFlagsBits,
    type SlashCommandBuilder,
} from "discord.js";
import i18n from "../../config/index.js";
import { type Rawon } from "../../structures/Rawon.js";
import { haveQueue } from "../../utils/decorators/MusicUtil.js";
import { buildPlayerEmbed, buildPlayerPanel } from "../../utils/functions/playerPanel.js";

@ApplyOptions<Command.Options>({
    name: "nowplaying",
    aliases: ["np"],
    description: i18n.__("commands.music.nowplaying.description"),
    detailedDescription: { usage: "{prefix}nowplaying" },
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
            .setName(opts.name ?? "nowplaying")
            .setDescription(
                opts.description ?? i18n.__("commands.music.nowplaying.description"),
            ) as SlashCommandBuilder;
    },
})
export class NowPlayingCommand extends ContextCommand {
    private getClient(ctx: CommandContext): Rawon {
        return ctx.client as Rawon;
    }

    @haveQueue
    public async contextRun(ctx: CommandContext): Promise<void> {
        const client = this.getClient(ctx);
        const guild = ctx.guild;
        const queue = guild?.queue;
        if (!guild || !queue) {
            return;
        }

        // A server with a request channel already has its player there, with the
        // controls; here the status alone is enough.
        if (client.requestChannelManager.hasRequestChannel(guild)) {
            await ctx.reply({ embeds: [buildPlayerEmbed(client, guild, "compact")] });
            return;
        }

        // Everywhere else this brings the player panel to wherever it was asked
        // for: the reply becomes the queue's panel, and the old one is removed.
        const reply = await ctx.reply(buildPlayerPanel(client, guild, "compact"));
        const current = queue.currentSong;
        if (current === undefined) {
            return;
        }

        // For a slash command the message is fetched through the interaction;
        // guessing at "the latest message in the channel" could pick up someone
        // else's, and a panel is a message that gets edited and deleted.
        const message =
            ctx.context instanceof BaseInteraction
                ? await (ctx.context as CommandInteraction).fetchReply().catch(() => null)
                : reply;
        if (message !== null) {
            await queue.setPanel(message, current.key);
        }
    }
}
