# Security policy

Needlecast is in alpha and has not yet received a third-party security audit.

Please do not report vulnerabilities in public issues if they contain live credentials, private collection data, or a reproducible exploit. Until a dedicated security contact is configured for the public repository, open a private GitHub vulnerability report if the repository supports it; otherwise contact the maintainer privately through their published GitHub profile.

Never commit Discord bot tokens, Discogs personal access tokens, encrypted credential stores, `.env` files, or logs containing secrets. Rotate any credential that was accidentally exposed.

Security-related changes should preserve Electron context isolation, sandboxing, loopback-only service binding, credential encryption, input validation, and restrictive navigation/IPC handling.
