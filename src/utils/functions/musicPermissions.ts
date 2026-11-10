import { type Guild, type GuildMember, PermissionFlagsBits } from "discord.js";
import { type Rawon } from "../../structures/Rawon.js";
import { type QueueSong } from "../../typings/index.js";

type MaybeMember = GuildMember | null | undefined;

/** Holds the DJ role, or manages the server. */
export async function hasDjPrivilege(
    client: Rawon,
    guild: Guild,
    member: MaybeMember,
): Promise<boolean> {
    if (!member) {
        return false;
    }
    if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return true;
    }

    const djRole = await client.utils.fetchDJRole(guild).catch(() => null);
    return djRole !== null && member.roles.cache.has(djRole.id);
}

/**
 * May `member` decide the fate of `song` for everyone listening: skip it
 * without a vote, remove it, stop the player. True for whoever requested the
 * track and for anyone with DJ privilege.
 */
export async function canOverrideTrack(
    client: Rawon,
    guild: Guild,
    member: MaybeMember,
    song: QueueSong | undefined,
): Promise<boolean> {
    if (!member) {
        return false;
    }

    return song?.requester.id === member.id || hasDjPrivilege(client, guild, member);
}

/**
 * With the DJ feature switched on, changing what plays next is reserved for DJs
 * as soon as more than one other listener is in the voice channel. This is the
 * rule `skipto` and `remove` have always applied.
 */
export async function isQueueLocked(
    client: Rawon,
    guild: Guild,
    member: MaybeMember,
): Promise<boolean> {
    if (client.data.data?.[guild.id]?.dj?.enable !== true) {
        return false;
    }

    const channelId = guild.queue?.connection?.joinConfig.channelId ?? "";
    const channel = guild.channels.cache.get(channelId);
    const present = channel?.isVoiceBased() === true ? channel.members.size : 0;
    if (present <= 2) {
        return false;
    }

    return !(await hasDjPrivilege(client, guild, member));
}
