import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const executablePath = resolve(
  process.argv[2] ?? "release/linux-unpacked/analog-canvas",
);
const output = resolve(process.argv[3] ?? "release/linux-smoke.png");
const temporary = await mkdtemp(join(tmpdir(), "analog-canvas-ui-smoke-"));
let application;

try {
  application = await electron.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu"],
    env: {
      ...process.env,
      ICM_PREVIEW_AUDIT: join(temporary, "requests.jsonl"),
      ICM_PREVIEW_USER_DATA: join(temporary, "user-data"),
      ICM_DESKTOP_PROJECTS: join(temporary, "projects"),
      ICM_PREVIEW_WAIT_FOR_DRIVER: "1",
    },
    timeout: 60_000,
  });
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  await expect
    .poll(() =>
      application.evaluate(
        () => typeof globalThis.__analogCanvasPreviewDriverReady,
      ),
    )
    .toBe("function");
  await application.evaluate(() =>
    globalThis.__analogCanvasPreviewDriverReady(),
  );
  const page = await application.firstWindow();
  await expect(page.getByTestId("schematic-canvas")).toBeVisible({
    timeout: 60_000,
  });
  const projectsDialog = page.getByRole("dialog", {
    name: "Local projects",
    exact: true,
  });
  if (await projectsDialog.count()) {
    await projectsDialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
  }
  await page
    .locator("summary")
    .filter({ hasText: /^Edit$/u })
    .click();
  await page
    .getByRole("button", { name: "Insert component… (I)", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Insert Component",
    exact: true,
  });
  await picker.getByLabel("Component search").fill("resistor");
  await picker.getByTestId("insert-component-resistor").click();
  await page
    .getByTestId("schematic-canvas")
    .click({ position: { x: 320, y: 260 } });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("instance-count")).toHaveText("1");
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("instance-count")).toHaveText("0");
  await page.keyboard.press("Control+Shift+z");
  await expect(page.getByTestId("instance-count")).toHaveText("1");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(1500);
  const projectFiles = (
    await readdir(join(temporary, "projects"), { recursive: true })
  ).filter((name) => name.endsWith(".icproj.json"));
  assert.equal(projectFiles.length, 1, "Expected one saved project");
  const project = JSON.parse(
    await readFile(join(temporary, "projects", projectFiles[0]), "utf8"),
  );
  const savedInstances =
    project.documents?.flatMap((document) => document.instances ?? []).length ??
    0;
  assert.equal(savedInstances, 1, "Expected one saved schematic instance");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  const requests = await readFile(join(temporary, "requests.jsonl"), "utf8");
  const remote = requests
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).url)
    .filter((url) => /^(?:https?|wss?):/iu.test(url));
  assert.deepEqual(remote, [], "The desktop renderer made external requests");
  await page.screenshot({ path: output, fullPage: true });
  console.log(`Desktop UI rendered: ${output}`);
} finally {
  await application?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await application?.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
