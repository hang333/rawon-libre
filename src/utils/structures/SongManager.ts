import { Collection, type GuildMember, type Snowflake, SnowflakeUtil } from "discord.js";
import { type Rawon } from "../../structures/Rawon.js";
import { type QueueSong, type Song } from "../../typings/index.js";

export class SongManager extends Collection<Snowflake, QueueSong> {
    private id = 0;

    public constructor(
        public readonly client: Rawon,
        public readonly guild: GuildMember["guild"],
    ) {
        super();
    }

    public addSong(song: Song, requester: GuildMember): Snowflake {
        const key = SnowflakeUtil.generate().toLocaleString();
        const data: QueueSong = {
            index: this.id++,
            key,
            requester,
            song,
        };

        this.set(key, data);
        return key;
    }

    public restoreSong(key: Snowflake, index: number, song: Song, requester: GuildMember): void {
        const data: QueueSong = {
            index,
            key,
            requester,
            song,
        };

        if (index >= this.id) {
            this.id = index + 1;
        }

        this.set(key, data);
    }

    public set(key: Snowflake, data: QueueSong): this {
        (this.client as Rawon | undefined)?.debugLog.logData(
            "info",
            "SONG_MANAGER",
            `New value added to ${this.guild.name}(${this.guild.id}) song manager. Key: ${key}`,
        );
        const result = super.set(key, data);
        void this.saveQueueState();
        return result;
    }

    public delete(key: Snowflake): boolean {
        (this.client as Rawon | undefined)?.debugLog.logData(
            "info",
            "SONG_MANAGER",
            `Value ${key} deleted from ${this.guild.name}(${this.guild.id}) song manager.`,
        );
        const result = super.delete(key);
        void this.saveQueueState();
        return result;
    }

    /**
     * Drop several songs and save once. Deleting them one at a time writes the
     * whole remaining queue to disk after each, which is quadratic on a long queue.
     */
    public deleteMany(keys: Iterable<Snowflake>): number {
        let removed = 0;
        for (const key of keys) {
            if (super.delete(key)) {
                removed++;
            }
        }

        if (removed > 0) {
            void this.saveQueueState();
        }
        return removed;
    }

    /**
     * Put the given songs in the given order, leaving every other song where it
     * is. The songs trade the positions they already hold between them, so no
     * index is ever shared and nothing outside the set moves.
     */
    public reposition(keys: Snowflake[]): void {
        const entries = keys
            .map((key) => this.get(key))
            .filter((entry): entry is QueueSong => entry !== undefined);
        const slots = entries.map((entry) => entry.index).sort((a, b) => a - b);

        for (const [position, entry] of entries.entries()) {
            entry.index = slots[position];
        }

        void this.saveQueueState();
    }

    public sortByIndex(): this {
        return this.sort((a, b) => a.index - b.index);
    }

    private async saveQueueState(): Promise<void> {
        try {
            const queue = this.guild.queue;
            if (queue?.songs && queue.connection) {
                // Whatever changed the queue also changed what a player panel shows.
                queue.notifyChanged();
                await queue.saveQueueState();
            }
        } catch {}
    }
}
