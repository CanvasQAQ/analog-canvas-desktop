# Analog Canvas 0.1 Preview

Analog Canvas is now packaged for Windows x64, macOS x64/arm64, and Linux x64
from the same source revision.

## Included

- Bundled `analog-canvas-device-svg-20261023` device library.
- Offline schematic editing with hierarchy, connectivity, undo/redo, project
  files, recovery, local components, SPICE/SCS import, and netlist/vector export.
- Windows NSIS and portable builds, macOS DMG and ZIP builds, and Linux AppImage,
  DEB, and tar.gz builds.
- SHA-256 checksums and corresponding source archive.

## Preview limitations

- Builds are unsigned. Windows SmartScreen or macOS Gatekeeper may require an
  explicit user override.
- Automatic updates, accounts, cloud projects, telemetry, and remote services
  are disabled or absent.
- Local Agent/MCP integration is not part of the desktop Preview distribution.
- Project data and recovery files are stored locally without encryption.

Verify the downloaded asset against `SHA256SUMS.txt`. The corresponding source
is attached to the Release and available from
<https://github.com/CanvasQAQ/analog-canvas-desktop>.
