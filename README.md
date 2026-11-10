<div align="center">

# Rawon Libre

**The AGPL-3.0 community continuation of [Rawon](https://github.com/stegripe/rawon).**

<a href="https://github.com/hang333/rawon-libre/actions?query=workflow%3A%22Lint+code+and+compile+setup+script%22"><img src="https://github.com/hang333/rawon-libre/workflows/Lint%20code%20and%20compile%20setup%20script/badge.svg" alt="CI Status" /></a>
<img src="https://badgen.net/badge/icon/typescript?icon=typescript&label" alt="TypeScript">
<img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0">

</div>

> A simple powerful Discord music (multi-)bot built to fulfill your production desires. Easy to use, with no coding required.

## About this fork

**Rawon Libre is the AGPL-3.0 open source continuation of [Rawon](https://github.com/stegripe/rawon).**

On 2026-05-04 the upstream project relicensed from **AGPL-3.0** to **CC-BY-NC-ND-4.0** — a licence
that is not open source, forbids commercial use, and forbids derivative works. This fork continues
the project from [`a1b0ef7`][fork-point], the last commit ever published under AGPL-3.0, and will
stay AGPL-3.0.

### What that means in practice

- Everything up to and including [`a1b0ef7`][fork-point] is upstream work released under AGPL-3.0.
  Copyright remains with Stegripe Development and the original contributors — that licence grant is
  irrevocable, which is precisely why this fork is possible.
- **No code from upstream commits after [`a1b0ef7`][fork-point] is included here, and none will be
  merged.** Those commits are CC-BY-NC-ND-4.0 and are incompatible with this project.
- Where upstream has since fixed a bug or added a feature, it is reimplemented independently from a
  description of the behaviour. Upstream's implementation is not copied, adapted, or consulted
  line-by-line.
- Contributions are welcome and are accepted under AGPL-3.0. Please do not submit patches derived
  from post-relicence upstream code.

[fork-point]: https://github.com/stegripe/rawon/commit/a1b0ef7e66e6dced13608ad9fc13cfa953441c55

## Features
- Production-ready, no coding required
- Request channel feature for seamless music experience
- A player panel with every track: buttons, a jump-to-track menu and an "add to queue" dialog, so
  playback can be run without typing a command
- Support for YouTube, Spotify, SoundCloud, Bilibili (multi-part videos included), and direct files
- Falls back to Bilibili when a search, or a track from a Spotify link, has no match on YouTube
- Play audio or video files uploaded straight to Discord, in the request channel or with `play`
- Run multiple bot instances for different voice channels
- Smart audio pre-caching for smoother playback
- Built-in Google login via Puppeteer for cookie management

## Controlling playback
Each command is available as a slash command and with the prefix, whichever of the two is enabled.

| Command | What it does |
| --- | --- |
| `play`, `playnext`, `search` | Queue a track: at the end, or right after the one that is playing |
| `pause`, `resume`, `skip`, `previous`, `seek` | Move around in what is playing |
| `queue`, `skipto`, `move`, `remove`, `clear` | Look at the queue and rearrange it |
| `repeat`, `shuffle`, `autoplay`, `volume`, `filter` | Change how it plays |
| `stop`, `leave` | Empty the queue and leave the voice channel |
| `nowplaying` | Bring the player panel to the channel you are in |

The **player panel** carries the same controls as buttons. The bot posts it when a track starts, and
a request channel shows a permanent one.

- ⏮️ ⏯️ ⏭️ ⏹️ 📋 — previous, pause or resume, skip, stop, show the queue
- 🔁 🔀 ♾️ 🔉 🔊 — repeat mode, shuffle, auto-play, volume down and up
- ⏪ ⏩ 🗑️ 📜 ➕ — back and forward ten seconds, remove the current track, lyrics, add a track
- A menu under the buttons jumps straight to any of the next 25 tracks

The panel stays in place while nothing is posted under it and is re-posted at the bottom of the
channel once the conversation has moved on. Its buttons work for anyone in the bot's voice channel
and keep working after a restart. Skipping, removing and stopping follow the same rules as the
commands: the track's requester, a DJ or a server manager decides alone, and anyone else casts a
vote to skip.

## Installation

### Prerequisites
- [Node.js](https://nodejs.org) version `22.14.0` or higher (Node 20 reached end-of-life on
  2026-04-30, and better-sqlite3 13 crashes on anything older than 22.14)
- [FFmpeg](https://ffmpeg.org/) for audio processing

> **Note**: Docker users don't need to install FFmpeg manually — it's included in the Docker image.

### Standard Setup (Node.js)
1. Download and install the prerequisites above
2. Clone or download this repository
3. Copy `.env.example` to `.env` and fill in the required values (at minimum: `DISCORD_TOKEN`)
4. Install dependencies:
```sh
pnpm install
```
5. Build the project:
```sh
pnpm run build
```
6. Start the bot:
```sh
pnpm start
```
7. (Optional) After the bot is online, set up a dedicated music channel:
```
<prefix>requestchannel <#channel>
```
Example: `!requestchannel #music-requests`

### Docker Setup (Recommended)

#### Using Docker Compose
1. Create a `.env` file with your configuration (copy from `.env.example`)
2. (Optional) Create `dev.env` for additional settings
3. Create a `docker-compose.yaml` file:
```yaml
services:
  rawon-libre:
    image: ghcr.io/hang333/rawon-libre:latest
    container_name: rawon-libre-bot
    restart: unless-stopped
    env_file:
      - .env
      - dev.env
    ports:
      - "${DEVTOOLS_PORT:-3000}:${DEVTOOLS_PORT:-3000}"
    volumes:
      - rawon-libre:/app/cache

volumes:
  rawon-libre:
```
4. Start the bot:
```sh
docker compose up -d
```
5. View logs:
```sh
docker logs -f rawon-libre-bot
```

#### Using Docker Run
```sh
docker run -d \
  --name rawon-libre-bot \
  --env-file .env \
  -p "${DEVTOOLS_PORT:-3000}:${DEVTOOLS_PORT:-3000}" \
  -v rawon-libre:/app/cache \
  --restart unless-stopped \
  ghcr.io/hang333/rawon-libre:latest
```

#### Volume Information
The `/app/cache` volume stores:
- `yt-dlp` binary for audio streaming
- `data.*` for persistent settings (request channels, player states)
- Cached audio files (if audio caching is enabled)
- Cookie file and profile data from Google login (see [Cookies Setup](./docs/COOKIES_SETUP.md))

#### Port Information
The `DEVTOOLS_PORT` (default: `3000`) is used for Chrome DevTools remote debugging proxy. This is required for `!login start` to work from a remote machine. Set `DEVTOOLS_PORT` in your `dev.env` file to use a different port.

## Configuration Files
- `.env.example` - Essential settings (Discord/Spotify token, prefix, IDs, etc.)
- `dev.env.example` - Optional developer settings (prefix/slash toggles, sharding, DevTools, debug mode, etc.)
- Bot-specific settings (embed color, yes/no emoji, splash, alt prefix, default volume, selection type, audio cache) are managed via the `setup` command (developer-only) and stored in the database. Use `setup view` to list available settings.

Use the ones you need/should and fill in the values.

### Multi-Bot Mode

Multi-bot mode is adaptive - no extra configuration needed!

- **Single token** = Single bot mode
- **Multiple tokens (comma-separated)** = Multi-bot mode automatically enabled

Example for multi-bot:
```env
DISCORD_TOKEN="token1, token2, token3"
```

Features:
- The first (order) token becomes the primary bot for general commands
- Each bot handles music commands for users in its voice channel
- Adaptive ordering - if the primary bot is not in a server, the next available bot takes over
- Each bot requires its own Discord application

## Documentation
- [Disclaimers](./docs/DISCLAIMERS.md) - Important legal information
- [Cookies Setup](./docs/COOKIES_SETUP.md) - Fix "Sign in to confirm you're not a bot" errors on hosting providers

### Common Issues

**"Sign in to confirm you're not a bot" errors?**

If you're hosting on cloud providers (AWS, GCP, Azure, Railway, etc.), you may encounter bot detection errors. See [Cookies Setup](./docs/COOKIES_SETUP.md) for the solution.

**Quick fix using the login command:**
```
!login start    # Opens a browser for Google login
!login status   # Check current login & cookie status
!login logout   # Clear the login session (wipes all cookies and profile data)
```

## Support & Questions
Please use [GitHub Issues](https://github.com/hang333/rawon-libre/issues) for bugs and questions
about this fork. Do not direct questions about Rawon Libre to the upstream project — it is a
separate, independently maintained codebase.

## Contributors

Rawon Libre stands on the work of everyone who built Rawon under AGPL-3.0.

### Upstream developers
- [Stegripe Developers](https://github.com/orgs/stegripe/teams/developer)

### Upstream translators
- [Stegripe Developers](https://github.com/orgs/stegripe/teams/developer) (en-US, id-ID, ko-KR, ms-MY)
- [@21Z](https://github.com/21Z) (en-US)
- [@lxndr-rl](https://github.com/lxndr-rl) (es-ES)
- [@MoustacheOff](https://github.com/MoustacheOff) (fr-FR)
- [@RabbitYuKu](https://github.com/RabbitYuKu) (zh-CN, zh-TW)
- [@RomaDevWorld](https://github.com/RomaDevWorld) (uk-UA)
- [@hmz121](https://github.com/hmz121) (vi-VN)
- [@melloirl](https://github.com/melloirl) (pt-BR)
- [@Ronner231](https://github.com/Ronner231) (ru-RU)
- [@Fyphen1223](https://github.com/Fyphen1223) (ja-JP)
- [@OsmanTunahan](https://github.com/OsmanTunahan) (tr-TR)

### Fork maintainer
- [@hang333](https://github.com/hang333)

## Licence

Rawon Libre is licensed under the **GNU Affero General Public License v3.0**. See [LICENSE](./LICENSE).

- Rawon, up to and including commit [`a1b0ef7`][fork-point] — © Stegripe Development and
  contributors, licensed under AGPL-3.0.
- Rawon Libre, changes after the fork point — © the Rawon Libre contributors, licensed under
  AGPL-3.0.

Because this bot interacts with users over a network, AGPL-3.0 §13 applies: if you run a modified
version, you must offer its source to your users. The `about` command links to this repository —
point it at your own fork if you deploy modified code.
