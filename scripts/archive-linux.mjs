import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(join(root, "apps/desktop/package.json"), "utf8"),
);
const releaseDirectory = join(root, "release");
const unpacked = join(releaseDirectory, "linux-unpacked");
const directoryName = `Analog-Canvas-${packageJson.version}-linux-x64`;
const temporary = await mkdtemp(join(tmpdir(), "analog-canvas-tar-"));
const staged = join(temporary, directoryName);
const archive = join(releaseDirectory, `${directoryName}.tar.gz`);

try {
  await mkdir(releaseDirectory, { recursive: true });
  await cp(unpacked, staged, { recursive: true });
  const result = spawnSync(
    "tar",
    ["-czf", archive, "-C", temporary, directoryName],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`tar exited with status ${String(result.status)}`);
  }
  console.log(`Wrote ${basename(archive)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
