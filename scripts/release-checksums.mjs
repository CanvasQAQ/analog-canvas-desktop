import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const releaseDirectory = resolve("release");
const platform = process.argv[2] ?? process.platform;
const checksumName = `SHA256SUMS-${platform}.txt`;
const artifactPattern = /\.(?:exe|dmg|zip|AppImage|deb|tar\.gz)$/u;

const names = (await readdir(releaseDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && artifactPattern.test(entry.name))
  .map((entry) => entry.name)
  .sort();

if (names.length === 0) {
  throw new Error(`No release artifacts found in ${releaseDirectory}`);
}

const lines = [];
for (const name of names) {
  const digest = createHash("sha256")
    .update(await readFile(join(releaseDirectory, name)))
    .digest("hex");
  lines.push(`${digest}  ${name}`);
}

await writeFile(join(releaseDirectory, checksumName), `${lines.join("\n")}\n`);
console.log(`Wrote ${checksumName} for ${names.length} artifact(s)`);
