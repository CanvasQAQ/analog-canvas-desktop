# Analog Canvas

Analog Canvas is a local-first, connectivity-aware schematic editor for analog
and mixed-signal design. It runs as an offline desktop application on Windows,
macOS, and Linux and ships with the
`analog-canvas-device-svg-20261023` device library.

Download the latest Preview builds from
[GitHub Releases](https://github.com/CanvasQAQ/analog-canvas-desktop/releases).

## Downloads

| Platform | Architecture | Recommended asset |
| --- | --- | --- |
| Windows | x64 | `Analog-Canvas-0.1.0-windows-x64-setup.exe` or `...-portable.exe` |
| macOS | x64 | `Analog-Canvas-0.1.0-macos-x64.dmg` |
| macOS | arm64 | `Analog-Canvas-0.1.0-macos-arm64.dmg` |
| Linux | x64 | `Analog-Canvas-0.1.0-linux-x86_64.AppImage`, `.deb`, or `.tar.gz` |

Every release includes `SHA256SUMS.txt` and a source archive. Preview builds are
unsigned. Windows SmartScreen and macOS Gatekeeper may therefore show a warning;
verify the checksum before deciding whether to run the application.

## What works

- Place and edit symbols from the bundled 109-device, Razavi-style SVG catalog.
- Draw connectivity-aware wires, select and move objects, rotate or mirror
  instances, and undo or redo edits.
- Organize a project into hierarchical Cells.
- Create, open, save, save as, and version local `.icproj.json` projects.
- Import structural SPICE and Spectre/SCS sources.
- Export deterministic SPICE/Spectre netlists and SVG, PNG, or PDF drawings.
- Work without an account, cloud connection, telemetry, or automatic updates.

The desktop renderer has no Node.js, filesystem, shell, or arbitrary IPC access.
It is served from a private `app://` origin, and the main process rejects remote
requests, external navigation, pop-up windows, and unapproved permissions.

## Install

### Windows

Run the NSIS installer, or extract and run the portable `.exe`. Keep portable
application resources together with the executable.

### macOS

Open the DMG, drag Analog Canvas to Applications, and launch it. For an unsigned
Preview that Gatekeeper blocks, open System Settings → Privacy & Security and
allow the app, or run:

```bash
xattr -dr com.apple.quarantine "/Applications/Analog Canvas.app"
```

### Linux

Make the AppImage executable and run it:

```bash
chmod +x Analog-Canvas-0.1.0-linux-x86_64.AppImage
./Analog-Canvas-0.1.0-linux-x86_64.AppImage
```

The `.deb` package can be installed with `sudo apt install ./Analog-Canvas-*.deb`.

## Project data

Projects are JSON files with the canonical `.icproj.json` extension. The
application also opens legacy `.icproj` files. User data, recovery copies, the
local component library, and recent-project entries remain on the local
machine. Project data is not encrypted at rest in this Preview.

The application does not contain accounts, cloud projects, a community gallery,
telemetry, crash reporting, remote help, or automatic updates.

## Build

Requirements: Node.js 24+, pnpm 11.16.0, and Git.

```bash
pnpm install --frozen-lockfile
pnpm --filter "@icm/editor^..." --if-present build
pnpm --filter @icm/editor exec vite build --config vite.desktop.config.ts
pnpm --filter @icm/desktop build:app
pnpm --filter @icm/desktop dist:linux
```

The cross-platform GitHub Actions workflow builds all platform artifacts from
the same tagged source revision. Releases are intentionally unsigned until
platform signing credentials are configured.

## Verification

```bash
pnpm exec vitest run apps/desktop/src --maxWorkers=2
pnpm typecheck
```

See [`drawic.md`](drawic.md) for the release baseline and acceptance matrix and
[`apps/desktop/SOURCES.md`](apps/desktop/SOURCES.md) for source attribution.

## Licensing and provenance

This distribution is based on the public
[`cascode-ai/analog-canvas`](https://github.com/cascode-ai/analog-canvas) project
and the AGPL-3.0 desktop shell adapted from LXY-freshman's Schematic Draft.
It is licensed under [AGPL-3.0-only](LICENSE). Corresponding source is available
in this repository and in each Release source archive.

The bundled device SVG export records source commit
`a239991de3d765ad68729a2fc59b87483c7d401c`, style profile
`razavi-textbook-v1`, and per-file SHA-256 values. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
