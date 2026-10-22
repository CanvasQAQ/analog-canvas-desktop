# Desktop release

The desktop fork publishes through
[`.github/workflows/release.yml`](../.github/workflows/release.yml). A tag
matching `v*` builds and publishes a Preview Release. Manual dispatch can build
without publishing, or publish a commit-specific preview when `publish` is
enabled.

## Release gate

The workflow must complete these stages before upload:

1. Install the pinned pnpm workspace with `pnpm install --frozen-lockfile`.
2. Run `pnpm typecheck`.
3. Build shared packages, the offline renderer, and the desktop shell.
4. Run desktop, model, netlist, exporter, and project-protocol tests.
5. Package on native Windows, macOS x64, macOS arm64, and Linux runners.
6. Launch the Linux package under Xvfb, render the editor, place a device, and
   reject external HTTP/WebSocket requests.
7. Generate per-platform SHA-256 files; the publish job combines them and adds
   a source archive checksum.

Any failed stage blocks Release publication.

## Artifacts

- Windows x64: NSIS installer and portable executable.
- macOS x64/arm64: DMG and ZIP.
- Linux x64: AppImage, DEB, and tar.gz.

Preview binaries are unsigned. The release notes must explain Windows
SmartScreen and macOS Gatekeeper prompts. Do not describe unsigned status as a
security feature.

## Local verification

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter "@icm/editor^..." --if-present build
pnpm --filter @icm/editor exec vite build --config vite.desktop.config.ts
pnpm --filter @icm/desktop build:preview
pnpm --filter @icm/desktop dist:linux
xvfb-run -a node scripts/smoke-desktop-package.mjs
xvfb-run -a node scripts/smoke-desktop-ui.mjs release/linux-unpacked/analog-canvas release/linux-smoke.png
node scripts/release-checksums.mjs linux
```

The packaged app must start with no developer tools installed. User projects,
recovery files, and settings belong in the platform application-data directory,
not inside the installation directory.
