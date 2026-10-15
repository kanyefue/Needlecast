# Needlecast

**Play your physical records into a Discord voice channel.** Needlecast is a local-first Windows desktop app that captures audio from a turntable or audio interface and streams it to a Discord voice channel. It includes an album-first library, CSV import, optional Discogs integration, automatic album-art lookup, and a bot `Listening to…` activity.

> **Status: early alpha — Windows 10/11 x64.** The project includes a Windows installer workflow, but builds are currently unsigned and still need end-to-end testing on a range of Windows PCs, audio devices, and Discord servers. Linux is not a supported packaged release yet.

## Choose how to use Needlecast

There are two ways to run the app. Most users should choose the Windows installer.

| Option | Best for | What to do |
| --- | --- | --- |
| **A. Windows installer (`.exe`) — recommended** | People who just want to use Needlecast | Open your repository's **Releases** page and download `Needlecast-Setup-<version>.exe`. Run the installer and launch Needlecast from the Start Menu or desktop shortcut. Node.js and Python are not required for normal use of the packaged app. |
| **B. Run from source (`npm install`)** | Developers, testers, and contributors | Install Node.js and Python, clone or download the source, run `npm install`, install the capture-agent requirements, then run `npm start`. Follow [Run from source](#option-b-run-from-source-npm-install). |

**Important:** the `.exe` download is available only after a maintainer has published a GitHub Release. If the Releases page is empty, use Option B or see [Build the Windows installer](#build-the-windows-installer) to create one.

> Maintainer: replace `YOUR-USERNAME/YOUR-REPOSITORY` in any example release/clone URLs with the actual GitHub repository path.

## What Needlecast does

- Captures live audio from a physical turntable connected to your PC's Line-In, microphone input, or USB audio interface.
- Sends the captured audio into a Discord voice channel using a Discord bot.
- Lets you select **one album at a time** as Now Playing; track-by-track selection is not required.
- Imports a local record collection from a Discogs CSV export, or lets you add an album manually.
- Optionally connects to Discogs for collection/release metadata and exact-release artwork.
- Looks up album covers through Discogs first (when configured), with Apple's public iTunes Search API as a fallback for CSV/manual albums.
- Shows the selected album and artist in the Discord bot's `Listening` activity.
- Optionally uses the selected album cover as the bot's profile avatar. This changes the bot's global avatar, not the artwork within the activity card, and may be rate-limited by Discord. The feature can be disabled in Settings.
- Clears Now Playing when the broadcast stops, based on the configured behavior.
- Keeps Discord/Discogs credentials in the operating system-backed Electron secure storage; credentials are not intended to be committed or placed in the source repository.

Needlecast streams audio from your connected audio input. Discogs and Apple are used for metadata/artwork only; Needlecast does not stream, download, or play music from those services.

## Option A: Install the Windows `.exe`

1. Open the GitHub repository in your browser.
2. Select **Releases**.
3. Download the latest `Needlecast-Setup-<version>.exe` asset.
4. Run the installer. Windows may warn that the installer is from an unknown publisher because alpha builds are not code-signed yet. Only run installers you have obtained from a repository/release you trust.
5. Launch **Needlecast** from the Start Menu or desktop shortcut.
6. Complete the first-run setup described in [Configure Discord](#configure-discord).
7. Select the correct audio input and test your input level before joining a voice channel.

The installer creates Start Menu and desktop shortcuts and lets you choose the installation directory. The installer is configured to keep Needlecast's app data during uninstall; uninstalling the app should not be treated as deleting its saved settings/library.

## Option B: Run from source (`npm install`)

### Requirements

- Windows 10/11 x64 for the current supported desktop workflow.
- [Node.js 22.12 or newer](https://nodejs.org/) with npm.
- [Python 3.11 or newer](https://www.python.org/downloads/windows/) with the Windows Python Launcher (`py.exe`). During installation, enable the Python Launcher option.
- Git, or download/extract the source ZIP.
- A Discord bot and a Discord server where you can invite it.
- A turntable connected to a suitable audio input. A USB audio interface with a true stereo Line-In is preferable to connecting line-level output straight to a motherboard microphone jack.

### Start the desktop app

Open PowerShell in the project root — the folder containing `package.json` — and run:

```powershell
npm install
py -3 -m pip install -r capture-agent/requirements.txt
npm run check
npm test
npm start
```

`npm install` installs the Node/Electron dependencies. The `py -3 -m pip` command installs the Python packages needed for live audio capture. `npm start` launches the Electron desktop app in developer mode; while running from source, Needlecast starts the capture agent using your local Python environment.

If `py` is not recognized, reinstall Python from the official website and enable the Python Launcher, or check that Python's installation directory is on your PATH. If you use a virtual environment, activate it in the same PowerShell window before starting the app.

### Useful development commands

```powershell
npm start                 # Run the Electron desktop app
npm run check             # JavaScript syntax checks
npm test                  # Run automated unit tests
npm run build:capture-agent # Bundle the Windows audio capture agent
npm run dist:win          # Build the Windows installer (requires bundled agent)
```

## Configure Discord

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Open its **Bot** section and create/add the bot user if required. Copy the **Bot Token**. The Application ID, public key, and client secret are not substitutes for the bot token.
3. Keep the token private. Never paste it into a source file, screenshot, GitHub issue, README, or commit.
4. Invite the bot to your Discord server using the installation/OAuth2 page. Give it only the permissions it needs in the target voice channel: **View Channel**, **Connect**, and **Speak**. Do not grant Administrator just to make Needlecast work.
5. In Discord, enable Developer Mode under **User Settings → Advanced**. Right-click your server and choose **Copy Server ID**.
6. Open Needlecast, complete the setup form, and enter the bot token and server ID. Save settings.
7. Make sure the bot can see and connect to the voice channel where you plan to broadcast. Check channel-specific permission overrides if it cannot join or speak.

The bot presence is metadata. It displays the album and artist as a `Listening` activity. Discord's standard bot activity API does not let Needlecast attach an arbitrary dynamic album cover inside the activity card. The optional album-artwork workaround changes the bot's profile avatar instead; it can be disabled in Needlecast Settings and is subject to Discord rate limits.

## Connect your turntable and broadcast

1. Connect the turntable's output to a suitable input on your PC. A phono turntable output normally needs a phono preamp; use a line-level output from a receiver/preamp or a suitable USB audio interface.
2. In Windows **Settings → System → Sound → Input**, confirm the device and verify that its level meter moves when audio is playing.
3. Launch Needlecast and choose the correct input device in **Input & destination**.
4. Start with a low capture gain. If the signal distorts or clips, lower the input level/gain. If it is very quiet, check your turntable preamp and input routing before adding large amounts of gain.
5. Select the Discord server/voice destination and start the broadcast using the app's monitor controls.
6. Confirm that the bot joins the intended channel and the live audio is audible. The audio is captured live; selecting Now Playing only changes the descriptive album metadata and bot activity.

**Audio hardware note:** a motherboard microphone jack is often mono and expects microphone-level input, while a turntable preamp/receiver line output is typically much stronger. A USB audio interface with a proper stereo line input is the recommended setup for better level control and stereo capture.

## Add your collection and album artwork

### Import a CSV (no Discogs login required)

1. Export your collection from Discogs as a CSV, or prepare a compatible CSV with `Artist` and `Title` columns.
2. In Needlecast, choose **Import CSV** and select the file.
3. Select the album that is currently on your turntable.
4. Artwork lookup is best-effort: Needlecast tries exact Discogs release artwork if Discogs is configured, then uses Apple's public iTunes Search API as a fallback. Not every pressing or independent release will be present in the fallback catalog.

Needlecast does not require a Discogs account to import or browse a local CSV. Collection details and cached artwork URLs are stored locally in the app's data directory.

### Add an album manually

Use **Manual entry** to enter an album and artist without importing a whole collection. This is useful for albums missing from the CSV or albums not in Discogs. Artwork lookup may find an image from Apple's catalog if its search result matches closely enough.

### Optional Discogs sync

1. Sign in to your Discogs account and open your account's developer/API settings to create a personal access token.
2. In Needlecast Settings, enter your Discogs username and token.
3. Use the Discogs sync control to import collection metadata.
4. If Discogs is unavailable or not configured, continue to use CSV imports and manual entries.

Use your own token. Needlecast does not include a shared Discogs token in the application. Discogs API requests are subject to external service availability and rate limits. If a sync fails or is rate-limited, wait and try again later; use the locally imported collection in the meantime.

### Choose Now Playing

Select the album card that matches the record on your turntable and mark it as playing. Needlecast updates the bot's `Listening` activity with the album and artist. When enabled, album artwork can also be applied to the bot's profile avatar; this affects the bot's visible profile image across Discord and may be rate-limited. Browsing/selecting another card is not intended to alter the live audio source.

## Build the Windows installer

Build the installer on **Windows x64**. You need Node.js 22.12+, Python 3.11+ and Git/source files. Run PowerShell from the repository root:

```powershell
npm install
npm run check
npm test
npm run build:capture-agent
npm run dist:win
```

The capture-agent build script installs its Python build dependencies, then uses PyInstaller to bundle the capture process as an executable. Electron Builder packages the desktop app and its bundled agent into an NSIS installer. The output is written under `release/`, normally with a name like:

```text
release/Needlecast-Setup-0.3.0-alpha.5.exe
```

The exact name follows the version in `package.json`. `build-resources/icon.ico` is used for the application/installer icon. Keep your preferred taskbar logo at that path if you change the icon.

## Publish a Windows installer using GitHub Actions

This repository includes `.github/workflows/windows-release.yml`. It runs on a Windows GitHub-hosted runner, installs Node.js and Python, runs the checks/tests, packages the capture agent, and builds the installer.

### Build a test installer artifact

1. Push the source and the workflow file to the repository's default branch.
2. Open the repository's **Actions** tab.
3. Choose **Windows installer** in the workflows list.
4. Select **Run workflow** and start the workflow on the default branch.
5. Wait for the workflow to complete successfully, open that run, and download the `needlecast-windows-installer` artifact.

The manual workflow produces an Actions artifact; it does not automatically create a public Release unless the workflow is run for a version tag.

### Publish a versioned GitHub Release

After reviewing/testing the build, push a version tag matching the version in `package.json`. For this source version, the tag would be:

```powershell
git tag v0.3.0-alpha.5
git push origin v0.3.0-alpha.5
```

The workflow is configured to build the `.exe` and attach it to a GitHub Release for tags beginning with `v`. Confirm the Actions run succeeded and check the repository's **Releases** page for the installer asset. Before wide distribution, consider signing the Windows executable; an unsigned installer may trigger Microsoft Defender SmartScreen warnings.

## Platform support

- **Windows 10/11 x64:** current target for the desktop workflow and packaged installer.
- **Linux:** no supported packaged installer yet. Electron can run on Linux, but the capture agent, packaging scripts, audio device behavior, secure credential storage and Discord voice pipeline have not been validated as a complete Linux release. Do not advertise Linux as supported until end-to-end tests exist.
- **macOS:** not currently supported as a packaged release.
- **Docker:** an earlier browser-based prototype remains in the repository as a developer/legacy path. Docker is not required for the Electron desktop application.

## Architecture overview

Needlecast is a local-first desktop app: Electron hosts the UI and local Node backend, while a dedicated capture-agent process owns the audio-device lifecycle. The installed app does not require a hosted Needlecast account or remote Needlecast server.

```text
Turntable / receiver / audio interface
                │ local input audio
                ▼
       Python capture agent
                │ local PCM/WebSocket
                ▼
 Electron app + local Node backend ───────► Discord voice channel
                │
                ├── Album library / CSV import
                ├── Optional Discogs API
                ├── Apple artwork search fallback
                └── Discord Listening activity / optional bot-avatar artwork
```

Relevant source paths:

- `desktop/` — Electron window, preload bridge, lifecycle and secure settings storage.
- `server.js` — local API, Discord bot/voice connection and broadcast lifecycle.
- `public/` — dark, amber-accented UI, library, settings, and broadcast monitor.
- `src/main/services/library-service.cjs` — local album library and CSV parsing.
- `src/main/services/discogs-service.cjs` — optional Discogs integration.
- `src/main/services/album-artwork-service.cjs` — Discogs-first artwork and Apple search fallback.
- `src/main/services/bot-avatar-service.cjs` — optional album-cover-to-bot-avatar behavior.
- `capture-agent/` — Python input capture and audio streaming process.
- `scripts/build-capture-agent.ps1` — packages the capture agent for the Windows installer.
- `.github/workflows/windows-release.yml` — CI build and Windows installer release workflow.
- `build-resources/icon.ico` — application and installer icon.

## Privacy and security

- Needlecast is designed to run locally. In desktop mode, its local web/audio services bind to loopback interfaces rather than being intended as public internet services.
- Discord and Discogs credentials are stored through Electron `safeStorage` and the operating system's credential protection where available. On Windows, protection is tied to the current Windows user. This does not protect against malware running as that same user.
- The capture agent is for live streaming and does not intentionally write captured audio to disk. Diagnostic logs may be written in the application data folder.
- Local library information and artwork cache are kept on the device.
- Do not commit `.env`, bot tokens, Discogs tokens, private collection exports, credential data, or logs that might expose secrets. `.gitignore` excludes common local secrets/build artifacts, but always inspect staged files before committing.
- Never use a normal Discord user account token or self-bot behavior. Use a bot created in the Discord Developer Portal.

See [`SECURITY.md`](SECURITY.md) for security reporting guidance and [`LICENSE`](LICENSE) for the license.

## Troubleshooting

### The bot does not join or speak

- Confirm the bot token and server ID in Needlecast Settings.
- Confirm the bot has **View Channel**, **Connect**, and **Speak** permissions for the target voice channel, including channel-specific overrides.
- Confirm that the bot is online in the correct server and that another app/session is not interfering with the voice connection.
- Run `npm run check` and `npm test` when testing from source. Check Needlecast's UI status and logs for more detail.

### No audio or distorted audio

- Verify Windows is receiving signal from the correct input device before starting Needlecast.
- Select the correct input in Needlecast and Windows sound settings.
- Lower the input gain if the sound clips. Use a line-level input or USB audio interface if possible; a mic jack may be mono or easily overloaded.
- Check that the turntable has the required phono preamp and that the cables are connected to the intended input.

### Album cover is missing or incorrect

- Cover art lookup is best-effort, and not every vinyl pressing exists in the fallback catalog.
- Configure Discogs if you want exact-release lookup where available.
- Check that the album artist/title in the CSV is spelled accurately. Manual entries can also be adjusted to improve the match.
- Verify that the computer can reach Discogs/Apple API endpoints over HTTPS.

### The bot's avatar does not change

- The avatar artwork feature is optional and can be disabled in Settings.
- Discord may rate-limit profile avatar updates. The activity text may still update even when an avatar change is deferred or rejected.
- The artwork updates the bot's global profile avatar; it does not create a custom large image inside the activity card.

### Installer fails or Windows warns about it

- Make sure the `.exe` came from the project's intended GitHub Release.
- Alpha installers may be unsigned and therefore show SmartScreen warnings. Do not bypass a warning unless you trust the source and understand the risk.
- If you built locally, rerun the commands in [Build the Windows installer](#build-the-windows-installer) and inspect the build output for errors.

## Contributing

Bug reports with clear reproduction steps are welcome. Before opening a pull request, run:

```powershell
npm run check
npm test
```

For audio-related reports, include the Windows version, input device, sample rate/channel configuration, and whether the issue also occurs outside Discord. Do not include credentials, private collection exports, or secret-bearing logs. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Needlecast is licensed under the MIT License. See [`LICENSE`](LICENSE).
