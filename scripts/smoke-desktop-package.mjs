import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "release/linux-unpacked/analog-canvas");
const temporary = await mkdtemp(join(tmpdir(), "analog-canvas-smoke-"));
const auditPath = join(temporary, "requests.jsonl");
const userData = join(temporary, "user-data");
const child = spawn(executable, ["--no-sandbox", "--disable-gpu"], {
  env: {
    ...process.env,
    ICM_PREVIEW_AUDIT: auditPath,
    ICM_PREVIEW_USER_DATA: userData,
  },
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const exit = new Promise((resolveExit) => {
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
});
const earlyExit = await Promise.race([
  exit,
  new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 12_000)),
]);

if (earlyExit) {
  await rm(temporary, { recursive: true, force: true });
  throw new Error(
    `Desktop process exited before the smoke window (${JSON.stringify(earlyExit)}):\n${stderr}`,
  );
}

let requests = "";
try {
  requests = await readFile(auditPath, "utf8");
} catch {
  requests = "";
}
const remote = requests
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line).url)
  .filter((url) => /^(?:https?|wss?):/iu.test(url));

try {
  if (process.platform === "win32") child.kill("SIGTERM");
  else process.kill(-child.pid, "SIGTERM");
} catch {
  child.kill("SIGTERM");
}
await Promise.race([
  exit,
  new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
]);
await rm(temporary, { recursive: true, force: true });

if (remote.length > 0) {
  throw new Error(`Desktop package attempted external requests:\n${remote.join("\n")}`);
}

console.log(`Desktop package stayed running with no external requests: ${executable}`);
