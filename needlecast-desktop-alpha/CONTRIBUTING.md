# Contributing to Needlecast

Thanks for helping improve Needlecast. This is an early desktop alpha, so focused bug reports and repeatable test cases are especially useful.

## Before opening a pull request

- Run `npm run check` and `npm test`.
- Do not include `.env`, personal access tokens, bot tokens, `credentials.dat`, private Discogs collection exports, or logs containing secrets.
- For UI changes, keep the existing dark graphite + amber visual direction and preserve keyboard access, focus states, and responsive layouts.
- For audio changes, describe input device, Windows version, sample rate, channel count, Discord voice behavior, and whether the failure reproduces without the physical turntable.
- For Discogs changes, add mocked tests instead of depending on a live account or API in CI. For CSV and Now Playing changes, include local-only tests that do not require Discord or Discogs credentials.

## Development principles

- Keep the app local-first; do not introduce telemetry or a required hosted account service without an explicit design review.
- Use narrow IPC APIs. Do not expose generic filesystem, shell, or Node.js access to the renderer.
- Keep credentials out of logs and source files. Keep Discogs requests authenticated with the user's own token, and ensure the application remains useful when no Discogs account is configured. Never use Discord user tokens or self-bot behavior.
- Prefer small modules with clear responsibilities over a microservice architecture for a single-user desktop app.
