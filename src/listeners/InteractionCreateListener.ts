import { setTimeout } from "node:timers";
import { ApplyOptions } from "@sapphire/decorators";
import { type Command, Events, Listener, type ListenerOptions } from "@sapphire/framework";
import {
    ApplicationCommandType,
    type BitFieldResolvable,
    type ButtonInteraction,
    Collection,
    GuildMember,
    type Interaction,
    Message,
    MessageFlags,
    PermissionsBitField,
    type PermissionsString,
    type Snowflake,
    type TextChannel,
} from "discord.js";
import { CommandContext } from "../structures/CommandContext.js";
import { type Rawon } from "../structures/Rawon.js";
import { createEmbed } from "../utils/functions/createEmbed.js";
import { i18n__, i18n__mf } from "../utils/functions/i18n.js";
import { isDeveloperOnly } from "../utils/functions/isDeveloperOnly.js";
import {
    asPanelInteraction,
    handlePlayerPanelInteraction,
} from "../utils/handlers/PlayerPanelHandler.js";

function hasSlashCommand(cmd: Command): boolean {
    return cmd.options.chatInputCommand !== undefined;
}

function getCommandOptions(cmd: Command): Command.Options {
    return cmd.options;
}

@ApplyOptions<ListenerOptions>({
    event: Events.InteractionCreate,
})
export class InteractionCreateListener extends Listener<typeof Events.InteractionCreate> {
    private readonly cooldowns = new Collection<string, Collection<Snowflake, number>>();
    private readonly processedInteractions = new Map<string, number>();
    private readonly CACHE_TTL = 10000;

    private cleanupCache(): void {
        const now = Date.now();
        for (const [key, timestamp] of this.processedInteractions) {
            if (now - timestamp > this.CACHE_TTL) {
                this.processedInteractions.delete(key);
            }
        }
    }

    public async run(interaction: Interaction): Promise<void> {
        const client = interaction.client as Rawon;

        const cacheKey = `${interaction.id}:${client.user?.id}`;
        if (this.processedInteractions.has(cacheKey)) {
            return;
        }
        this.processedInteractions.set(cacheKey, Date.now());

        if (this.processedInteractions.size > 100) {
            this.cleanupCache();
        }

        this.container.debugLog.logData("info", "INTERACTION_CREATE", [
            ["Type", interaction.type.toString()],
            [
                "Guild",
                interaction.inGuild()
                    ? `${interaction.guild?.name ?? "[???]"}(${interaction.guildId})`
                    : "DM",
            ],
            [
                "Channel",
                (interaction.channel?.type ?? "DM") === "DM"
                    ? "DM"
                    : `${(interaction.channel as TextChannel).name}(${(interaction.channel as TextChannel).id})`,
            ],
            ["User", `${interaction.user.tag}(${interaction.user.id})`],
        ]);

        if (!interaction.inGuild() || !client.commands.isReady) {
            return;
        }

        // A player panel belongs to the bot that posted it, so its buttons, menu
        // and dialog skip the routing that decides which bot answers a command.
        const panelInteraction = asPanelInteraction(interaction);
        if (panelInteraction !== null) {
            try {
                await handlePlayerPanelInteraction(panelInteraction);
            } catch (error: unknown) {
                const handled = await this.handleInteractionPermissionError(
                    interaction,
                    error,
                    "handle player panel interaction",
                );

                if (!handled) {
                    throw error;
                }
            }
            return;
        }

        if (interaction.guild && !interaction.isMessageComponent()) {
            const thisBotGuild = client.guilds.cache.get(interaction.guild.id);
            if (!thisBotGuild) {
                return;
            }

            let isMusicCommand = false;
            let commandName = "";

            if (interaction.isChatInputCommand()) {
                commandName = interaction.commandName;
                const cmd = client.commands
                    .filter((x: Command) => hasSlashCommand(x))
                    .find((x: Command) => x.name === commandName);

                const musicCommands = [
                    "volume",
                    "vol",
                    "loop",
                    "repeat",
                    "shuffle",
                    "autoplay",
                    "ap",
                    "filter",
                    "skip",
                    "skipto",
                    "pause",
                    "resume",
                    "stop",
                    "disconnect",
                    "dc",
                    "remove",
                    "seek",
                    "previous",
                    "clear",
                    "move",
                    "leave",
                ];
                isMusicCommand =
                    cmd !== undefined &&
                    (musicCommands.includes(commandName) ||
                        (cmd.aliases.length > 0 &&
                            musicCommands.some((name) => cmd.aliases.includes(name))));
            }

            const thisBotGuildForContext = interaction.guild
                ? (client.guilds.cache.get(interaction.guild.id) ?? interaction.guild)
                : interaction.guild;
            const __ = i18n__(client, thisBotGuildForContext);
            const __mf = i18n__mf(client, thisBotGuildForContext);

            if (isMusicCommand) {
                let member = thisBotGuild.members.cache.get(interaction.user.id);
                if (!member) {
                    try {
                        const fetchedMember = await thisBotGuild.members
                            .fetch(interaction.user.id)
                            .catch(() => null);
                        if (fetchedMember) {
                            member = fetchedMember;
                        }
                    } catch {
                        if (
                            interaction.member &&
                            interaction.member instanceof GuildMember &&
                            interaction.member.guild.id === thisBotGuild.id
                        ) {
                            member = interaction.member;
                        }
                    }
                }
                if (
                    !member &&
                    interaction.member &&
                    interaction.member instanceof GuildMember &&
                    interaction.member.guild.id === thisBotGuild.id
                ) {
                    member = interaction.member;
                }

                const userVoiceChannelId = member?.voice.channelId ?? null;

                this.container.logger.debug(
                    `[MultiBot] ${client.user?.tag} PRE-CHECK music interaction "${commandName}" from ${interaction.user.tag}: ` +
                        `userVoiceChannel=${userVoiceChannelId ?? "none"}`,
                );

                if (userVoiceChannelId) {
                    const shouldRespond = client.multiBotManager.shouldRespondToMusicCommand(
                        client,
                        thisBotGuild,
                        userVoiceChannelId,
                    );

                    this.container.logger.debug(
                        `[MultiBot] ${client.user?.tag} PRE-CHECK result for music interaction "${commandName}": shouldRespond=${shouldRespond}`,
                    );

                    if (!shouldRespond) {
                        this.container.logger.warn(
                            `[MultiBot] ${client.user?.tag} ❌ BLOCKING music interaction "${commandName}" from ${interaction.user.tag} ` +
                                `- NOT in same voice channel (user in: ${userVoiceChannelId}). RETURNING EARLY - INTERACTION WILL NOT BE EXECUTED!`,
                        );
                        if (interaction.isRepliable()) {
                            const primaryBot =
                                client.multiBotManager.getResponsibleBot(thisBotGuild);
                            const botMention = primaryBot
                                ? `<@${primaryBot.user?.id}>`
                                : __("events.createInteraction.primaryBotFallback");
                            await this.safeReply(
                                interaction,
                                {
                                    flags: MessageFlags.Ephemeral,
                                    embeds: [
                                        createEmbed(
                                            "error",
                                            __mf("events.createInteraction.wrongBot", {
                                                botMention,
                                            }),
                                            true,
                                        ),
                                    ],
                                },
                                "reply to wrong-bot music interaction",
                            );
                        }
                        return;
                    }

                    this.container.logger.debug(
                        `[MultiBot] ${client.user?.tag} ✅ ALLOWING music interaction "${commandName}" - will proceed to command handler`,
                    );
                } else if (!client.multiBotManager.shouldRespond(client, thisBotGuild)) {
                    this.container.logger.debug(
                        `[MultiBot] ${client.user?.tag} skipping music interaction "${commandName}" - user not in voice and not responsible bot`,
                    );
                    if (interaction.isRepliable()) {
                        const primaryBot = client.multiBotManager.getResponsibleBot(thisBotGuild);
                        const botMention = primaryBot
                            ? `<@${primaryBot.user?.id}>`
                            : __("events.createInteraction.primaryBotFallback");
                        await this.safeReply(
                            interaction,
                            {
                                flags: MessageFlags.Ephemeral,
                                embeds: [
                                    createEmbed(
                                        "error",
                                        __mf("events.createInteraction.wrongBot", {
                                            botMention,
                                        }),
                                        true,
                                    ),
                                ],
                            },
                            "reply to wrong-bot non-voice interaction",
                        );
                    }
                    return;
                }
            } else if (interaction.isChatInputCommand()) {
                commandName = interaction.commandName;
                if (!client.multiBotManager.shouldRespond(client, thisBotGuild)) {
                    this.container.logger.debug(
                        `[MultiBot] ${client.user?.tag} skipping interaction "${commandName}" - not responsible bot`,
                    );
                    if (interaction.isRepliable()) {
                        const primaryBot = client.multiBotManager.getResponsibleBot(thisBotGuild);
                        const botMention = primaryBot
                            ? `<@${primaryBot.user?.id}>`
                            : __("events.createInteraction.primaryBotFallback");
                        await this.safeReply(
                            interaction,
                            {
                                flags: MessageFlags.Ephemeral,
                                embeds: [
                                    createEmbed(
                                        "error",
                                        __mf("events.createInteraction.wrongBot", {
                                            botMention,
                                        }),
                                        true,
                                    ),
                                ],
                            },
                            "reply to wrong-bot slash interaction",
                        );
                    }
                    return;
                }
            } else if (!client.multiBotManager.shouldRespond(client, thisBotGuild)) {
                this.container.logger.debug(
                    `[MultiBot] ${client.user?.tag} skipping interaction - not responsible bot`,
                );
                if (interaction.isRepliable()) {
                    const primaryBot = client.multiBotManager.getResponsibleBot(thisBotGuild);
                    const botMention = primaryBot
                        ? `<@${primaryBot.user?.id}>`
                        : __("events.createInteraction.primaryBotFallback");
                    await this.safeReply(
                        interaction,
                        {
                            flags: MessageFlags.Ephemeral,
                            embeds: [
                                createEmbed(
                                    "error",
                                    __mf("events.createInteraction.wrongBot", {
                                        botMention,
                                    }),
                                    true,
                                ),
                            ],
                        },
                        "reply to wrong-bot interaction",
                    );
                }
                return;
            }
        }

        const thisBotGuildForContext = interaction.guild
            ? (client.guilds.cache.get(interaction.guild.id) ?? interaction.guild)
            : interaction.guild;

        const __mf = i18n__mf(client, thisBotGuildForContext);

        if (interaction.isButton()) {
            const val = this.container.utils.decode(interaction.customId);
            const user = val.split("_")[0] ?? "";
            const cmd = val.split("_")[1] ?? "";

            if (cmd === "delete-msg") {
                if (
                    interaction.user.id !== user &&
                    !new PermissionsBitField(
                        interaction.member.permissions as
                            | BitFieldResolvable<PermissionsString, bigint>
                            | undefined,
                    ).has(PermissionsBitField.Flags.ManageMessages)
                ) {
                    void this.safeReply(
                        interaction,
                        {
                            flags: MessageFlags.Ephemeral,
                            embeds: [
                                createEmbed(
                                    "error",
                                    __mf("events.createInteraction.message1", {
                                        user: user.toString(),
                                    }),
                                    true,
                                ),
                            ],
                        },
                        "reply to unauthorized message button usage",
                    );
                } else {
                    const msg = await interaction.channel?.messages
                        .fetch(interaction.message.id)
                        .catch(() => null);
                    if (msg?.deletable === true) {
                        msg.delete().catch(() => null);
                    }
                }
            }
        }

        const context = new CommandContext(interaction);

        if (
            interaction.guild &&
            thisBotGuildForContext &&
            thisBotGuildForContext !== interaction.guild
        ) {
            Object.defineProperty(context, "guild", {
                value: thisBotGuildForContext,
                writable: false,
                enumerable: true,
                configurable: true,
            });
            this.container.logger.debug(
                `[MultiBot] ${client.user?.tag} overrode context.guild with thisBotGuild for interaction`,
            );
        }

        if (interaction.isUserContextMenuCommand()) {
            const data =
                interaction.options.getUser("user") ?? interaction.options.get("message")?.message;
            let dataType = ApplicationCommandType.User;

            if (data instanceof Message) {
                dataType = ApplicationCommandType.Message;
            }

            const cmd = client.commands.find((x: Command) =>
                dataType === ApplicationCommandType.Message
                    ? getCommandOptions(x).contextChat === interaction.commandName
                    : getCommandOptions(x).contextUser === interaction.commandName,
            );
            if (cmd) {
                const isDeveloper = this.container.config.devs.includes(interaction.user.id);
                if (isDeveloperOnly(cmd) && !isDeveloper) {
                    await this.safeReply(
                        interaction,
                        {
                            flags: MessageFlags.Ephemeral,
                            embeds: [
                                createEmbed(
                                    "error",
                                    __mf("events.createInteraction.devOnly"),
                                    true,
                                ),
                            ],
                        },
                        "reply to dev-only context menu usage",
                    );
                    this.container.logger.warn(
                        `[MultiBot] ${client.user?.tag} ❌ BLOCKED non-dev ${interaction.user.tag} [${interaction.user.id}] from using dev-only context/menu ${interaction.commandName}`,
                    );
                    return;
                }
                context.additionalArgs.set("options", data);
                const ctxCmd = cmd as { contextRun?: (ctx: CommandContext) => Promise<unknown> };
                void ctxCmd.contextRun?.(context);

                if (thisBotGuildForContext && interaction.channelId) {
                    const isReqChannel = client.requestChannelManager.isRequestChannel(
                        thisBotGuildForContext,
                        interaction.channelId,
                    );
                    if (isReqChannel) {
                        setTimeout(async () => {
                            try {
                                await interaction.deleteReply();
                            } catch {}
                        }, 60_000);
                    }
                }
            }
        }

        if (interaction.isCommand()) {
            const cmd = client.commands
                .filter((x: Command) => hasSlashCommand(x))
                .find((x: Command) => x.name === interaction.commandName);
            if (cmd) {
                if (!this.cooldowns.has(cmd.name)) {
                    this.cooldowns.set(cmd.name, new Collection());
                }

                const now = Date.now();
                const timestamps = this.cooldowns.get(cmd.name);
                const cooldownAmount = (getCommandOptions(cmd).cooldown ?? 3) * 1_000;
                const isDeveloper = this.container.config.devs.includes(interaction.user.id);

                if (!isDeveloper) {
                    if (timestamps?.has(interaction.user.id) === true) {
                        const expirationTime =
                            (timestamps.get(interaction.user.id) ?? 0) + cooldownAmount;
                        if (now < expirationTime) {
                            const timeLeft = (expirationTime - now) / 1_000;
                            await this.safeReply(
                                interaction,
                                {
                                    flags: MessageFlags.Ephemeral,
                                    embeds: [
                                        createEmbed(
                                            "warn",
                                            `⚠️ **|** ${__mf("utils.cooldownMessage", {
                                                author: interaction.user.toString(),
                                                timeleft: `**\`${timeLeft.toFixed(1)}\`**`,
                                            })}`,
                                        ),
                                    ],
                                },
                                "reply to slash cooldown",
                            );
                            return;
                        }

                        timestamps.set(interaction.user.id, now);
                        setTimeout(() => timestamps?.delete(interaction.user.id), cooldownAmount);
                    } else {
                        timestamps?.set(interaction.user.id, now);
                        setTimeout(() => timestamps?.delete(interaction.user.id), cooldownAmount);
                    }
                }

                if (isDeveloperOnly(cmd) && !isDeveloper) {
                    await this.safeReply(
                        interaction,
                        {
                            flags: MessageFlags.Ephemeral,
                            embeds: [
                                createEmbed(
                                    "error",
                                    __mf("events.createInteraction.devOnly"),
                                    true,
                                ),
                            ],
                        },
                        "reply to dev-only slash usage",
                    );
                    this.container.logger.warn(
                        `[MultiBot] ${client.user?.tag} ❌ BLOCKED non-dev ${interaction.user.tag} [${interaction.user.id}] from using dev-only slash ${interaction.commandName}`,
                    );
                    return;
                }

                this.container.logger.debug(
                    `[MultiBot] ${client.user?.tag} ✅ EXECUTING slash command "${interaction.commandName}" from ${interaction.user.tag}`,
                );
                this.container.logger.debug(
                    `${interaction.user.tag} [${interaction.user.id}] used /${interaction.commandName} ` +
                        `in #${(interaction.channel as TextChannel)?.name ?? "unknown"} [${interaction.channelId}] ` +
                        `in guild: ${thisBotGuildForContext?.name ?? interaction.guild?.name} [${interaction.guildId}]`,
                );
                const ctxCmd2 = cmd as { contextRun?: (ctx: CommandContext) => Promise<unknown> };
                void ctxCmd2.contextRun?.(context);

                if (thisBotGuildForContext && interaction.channelId) {
                    const isReqChannel = client.requestChannelManager.isRequestChannel(
                        thisBotGuildForContext,
                        interaction.channelId,
                    );
                    if (isReqChannel) {
                        setTimeout(async () => {
                            try {
                                await interaction.deleteReply();
                            } catch {}
                        }, 60_000);
                    }
                }
            } else {
                this.container.logger.warn(
                    `[MultiBot] ${client.user?.tag} command not found for interaction "${interaction.commandName}"`,
                );
            }
        }

        if (interaction.isStringSelectMenu()) {
            const val = this.container.utils.decode(interaction.customId);
            const user = val.split("_")[0] ?? "";
            const cmd = val.split("_")[1] ?? "";
            const exec = (val.split("_")[2] ?? "yes") === "yes";

            if (interaction.user.id !== user) {
                void this.safeReply(
                    interaction,
                    {
                        flags: MessageFlags.Ephemeral,
                        embeds: [
                            createEmbed(
                                "error",
                                __mf("events.createInteraction.message1", {
                                    user: user.toString(),
                                }),
                                true,
                            ),
                        ],
                    },
                    "reply to unauthorized select menu usage",
                );
            }
            if (cmd && user === interaction.user.id && exec) {
                const command = client.commands
                    .filter((x: Command) => hasSlashCommand(x))
                    .find((x: Command) => x.name === cmd);
                if (command) {
                    const isDeveloper = this.container.config.devs.includes(interaction.user.id);
                    if (isDeveloperOnly(command) && !isDeveloper) {
                        await this.safeReply(
                            interaction,
                            {
                                flags: MessageFlags.Ephemeral,
                                embeds: [
                                    createEmbed(
                                        "error",
                                        __mf("events.createInteraction.devOnly"),
                                        true,
                                    ),
                                ],
                            },
                            "reply to dev-only select menu usage",
                        );
                        this.container.logger.warn(
                            `[MultiBot] ${client.user?.tag} ❌ BLOCKED non-dev ${interaction.user.tag} [${interaction.user.id}] from using dev-only select ${interaction.customId}`,
                        );
                        return;
                    }
                    context.additionalArgs.set("values", interaction.values);
                    const ctxCmd3 = command as {
                        contextRun?: (ctx: CommandContext) => Promise<unknown>;
                    };
                    void ctxCmd3.contextRun?.(context);

                    if (thisBotGuildForContext && interaction.channelId) {
                        const isReqChannel = client.requestChannelManager.isRequestChannel(
                            thisBotGuildForContext,
                            interaction.channelId,
                        );
                        if (isReqChannel) {
                            setTimeout(async () => {
                                try {
                                    await interaction.deleteReply();
                                } catch {}
                            }, 60_000);
                        }
                    }
                }
            }
        }
    }

    private isPermissionLikeError(error: unknown): boolean {
        if (typeof error !== "object" || error === null) {
            return false;
        }

        const maybeError = error as { code?: number | string; message?: string };
        const rawCode = maybeError.code;
        const code = typeof rawCode === "number" ? rawCode : Number.parseInt(`${rawCode}`, 10);

        if ([50013, 50001, 10003].includes(code)) {
            return true;
        }

        const message = maybeError.message?.toLowerCase() ?? "";
        return (
            message.includes("missing permissions") ||
            message.includes("missing access") ||
            message.includes("cannot send messages")
        );
    }

    private getMissingInteractionPermissions(interaction: Interaction): bigint[] {
        if (!interaction.inGuild() || !interaction.guild || !interaction.channel) {
            return [];
        }

        const me = interaction.guild.members.me;
        if (!me || !("permissionsFor" in interaction.channel)) {
            return [];
        }

        const requiredPermissions: bigint[] = [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.EmbedLinks,
        ];

        if ("isThread" in interaction.channel && interaction.channel.isThread()) {
            requiredPermissions.push(PermissionsBitField.Flags.SendMessagesInThreads);
        }

        const channelPermissions = interaction.channel.permissionsFor(me);
        if (!channelPermissions) {
            return requiredPermissions;
        }

        return requiredPermissions.filter((permission) => !channelPermissions.has(permission));
    }

    private async notifyPermissionFallback(interaction: Interaction): Promise<void> {
        if (!interaction.inGuild() || !interaction.guild) {
            return;
        }

        const client = interaction.client as Rawon;
        const thisBotGuild = client.guilds.cache.get(interaction.guild.id) ?? interaction.guild;
        const __mf = i18n__mf(client, thisBotGuild);

        const missingPermissions = this.getMissingInteractionPermissions(interaction);
        const formattedPermissions =
            missingPermissions.length > 0
                ? missingPermissions
                      .map((permission) => {
                          const permissionName = Object.entries(PermissionsBitField.Flags).find(
                              ([, value]) => value === permission,
                          )?.[0];

                          return `- \`${permissionName ?? permission.toString()}\``;
                      })
                      .join("\n")
                : "- `Unknown`";

        const messageText = __mf("utils.commonUtil.botMissingChannelPerms", {
            channel: interaction.channelId ? `<#${interaction.channelId}>` : "#unknown",
            permissions: formattedPermissions,
        });

        await interaction.user
            .send({
                embeds: [createEmbed("error", messageText, true)],
            })
            .catch(() => null);
    }

    private async handleInteractionPermissionError(
        interaction: Interaction,
        error: unknown,
        action: string,
    ): Promise<boolean> {
        if (!this.isPermissionLikeError(error)) {
            return false;
        }

        await this.notifyPermissionFallback(interaction);
        this.container.logger.warn(
            `[InteractionCreate] Permission issue while trying to ${action}. ` +
                `interaction=${interaction.id}, guild=${interaction.guildId ?? "DM"}, channel=${interaction.channelId ?? "unknown"}`,
        );
        return true;
    }

    private async safeReply(
        interaction: Interaction,
        options: Parameters<ButtonInteraction["reply"]>[0],
        action: string,
    ): Promise<boolean> {
        if (!interaction.isRepliable()) {
            return false;
        }

        try {
            await interaction.reply(options);
            return true;
        } catch (error: unknown) {
            const handled = await this.handleInteractionPermissionError(interaction, error, action);
            if (handled) {
                return false;
            }

            throw error;
        }
    }
}
