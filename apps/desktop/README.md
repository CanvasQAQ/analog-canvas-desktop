# Analog Canvas desktop shell

This package wraps the offline editor bundle in a hardened Electron main process.
The renderer is served from the private `app://analog-canvas` origin and has no
Node.js, filesystem, shell, subprocess, or generic IPC access.

## Build

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter "@icm/editor^..." --if-present build
pnpm --filter @icm/editor exec vite build --config vite.desktop.config.ts
pnpm --filter @icm/desktop build:preview
pnpm --filter @icm/desktop dist:linux
```

`electron-builder.yml` in this directory is the canonical packaging config. It
builds:

- Windows x64 NSIS and portable executables.
- macOS x64/arm64 DMG and ZIP files.
- Linux x64 AppImage and DEB packages; the release workflow adds a tar.gz of
  `release/linux-unpacked`.

The desktop shell is bundled completely by `scripts/build.mjs`. Runtime
`node_modules` must not be packaged; `app.asar` should remain a small bundle of
`dist/main.mjs` and the package manifest.

## Local verification

```bash
xvfb-run -a node ../../scripts/smoke-desktop-package.mjs
xvfb-run -a node ../../scripts/smoke-desktop-ui.mjs release/linux-unpacked/analog-canvas release/linux-smoke.png
```

The smoke tests launch the packaged executable, render the editor, place a
resistor, and reject external network requests. The GitHub
[`release.yml`](../../.github/workflows/release.yml) workflow is the only
publishing path.

## Data and security

Projects, recovery copies, the local component library, and recent-project
entries remain on the local machine. Project data is not encrypted at rest in
the Preview. The app does not include accounts, cloud storage, telemetry,
automatic updates, or a runtime network fallback.

Preview artifacts are unsigned. Windows and macOS may display an operating
system warning; users must verify the Release checksum before choosing to run
the application.

The desktop shell is adapted from LXY-freshman/Schematic Draft under
AGPL-3.0-only. See [SOURCES.md](SOURCES.md) and
[upstream-NOTICE.md](upstream-NOTICE.md).
