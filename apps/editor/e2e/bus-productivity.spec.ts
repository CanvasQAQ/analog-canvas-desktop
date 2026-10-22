import { expect, test, type Page } from "@playwright/test";
import { serializeProject } from "@icm/project-protocol";
import { executeProjectTransaction, proposeWireIntent } from "@icm/edit-engine";
import { builtInSymbols, createProjectSymbolResolver } from "@icm/symbols";
import {
  createEmptyProject,
  createRoutePath,
  type CircuitProject,
} from "@icm/model";
import { busReuseProject } from "./bus-reuse-fixtures";
import {
  clickDrawTool,
  clickNetlistWorkflowCommand,
  expectRecovered,
  exportedProject,
  openProject,
} from "./editor-fixtures";
import { clickRoute, copySelectionAt } from "./canvas-fixtures";
import { openSelectionShelf } from "./manual-editor-fixtures";

test("expands mixed Labels from L onto selected branches with one undo and safe cancellation", async ({
  page,
}) => {
  const project = createEmptyProject("expanded-label-ui", "Expanded Labels");
  const document = project.documents[0]!;
  for (let index = 0; index < 3; index++) {
    const netId = `n${index}`,
      routeId = `wire${index}`;
    document.nets.push({ id: netId, terminals: [] });
    document.junctions.push(
      { id: `a${index}`, netId, position: { x: 200, y: 200 + index * 100 } },
      { id: `b${index}`, netId, position: { x: 500, y: 200 + index * 100 } },
    );
    document.routes.push(
      createRoutePath({
        id: routeId,
        netId,
        start: { kind: "junction", junctionId: `a${index}` },
        end: { kind: "junction", junctionId: `b${index}` },
        bends: [],
        modes: ["manual"],
      }),
    );
  }
  await openProject(page, serializeProject(project));
  const before: CircuitProject = await exportedProject(page);
  await page.keyboard.press("ControlOrMeta+d");
  for (let index = 0; index < 3; index++) {
    if (index) await page.keyboard.down("Shift");
    await clickRoute(page, `wire${index}`);
    await page.keyboard.up("Shift");
  }
  await page.keyboard.press("l");
  await page
    .getByRole("textbox", { name: "Canvas text editor" })
    .fill("CLK,DATA<1:0>");
  await page.keyboard.press("Escape");
  expect((await exportedProject(page)).documents).toEqual(before.documents);
  await page.keyboard.press("ControlOrMeta+d");
  for (let index = 0; index < 3; index++) {
    if (index) await page.keyboard.down("Shift");
    await clickRoute(page, `wire${index}`);
    await page.keyboard.up("Shift");
  }
  await page.keyboard.press("l");
  await page
    .getByRole("textbox", { name: "Canvas text editor" })
    .fill("CLK,DATA<1:0>");
  await page
    .getByRole("button", { name: "Expand onto selected branches" })
    .click();
  const after: CircuitProject = await exportedProject(page);
  expect(after.documents[0]!.annotations).toHaveLength(3);
  expect(
    after.documents[0]!.connectivityEvidence.filter(
      (claim) => claim.kind === "name-claim",
    ).map((claim) => claim.name),
  ).toEqual(["CLK", "DATA<1>", "DATA<0>"]);
  await page.keyboard.press("ControlOrMeta+z");
  expect((await exportedProject(page)).documents[0]!.annotations).toHaveLength(
    0,
  );
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect((await exportedProject(page)).documents[0]!.annotations).toEqual(
    after.documents[0]!.annotations,
  );
});

async function point(page: Page, x: number, y: number) {
  return page.getByTestId("schematic-canvas").evaluate(
    (svg, p) => {
      const matrix = (svg as SVGSVGElement).getScreenCTM()!;
      const screen = new DOMPoint(p.x, p.y).matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    },
    { x, y },
  );
}

test("chooses, marks, traces and clears concrete members through Properties", async ({
  page,
}) => {
  await openProject(page, serializeProject(busReuseProject()));
  await clickDrawTool(page, "no-connect");
  await page.getByTestId("terminal-X2-IN<1:0>").click();
  await openSelectionShelf(page);
  const inspector = page.getByRole("region", { name: "Signal members" });
  await inspector
    .getByLabel("Inspect member", { exact: true })
    .selectOption({ label: "IN<0> · Unconnected" });
  await page.getByRole("button", { name: "Mark NoConn", exact: true }).click();
  let after: CircuitProject = await exportedProject(page);
  const child = after.documents.find((cell) => cell.id === "child")!;
  const zero = child.netlist!.terminals[0]!.signal!.members.find(
    (member) => member.name === "IN<0>",
  )!;
  expect(after.documents[0]!.noConnects).toEqual([
    expect.objectContaining({
      endpoint: {
        kind: "terminal",
        instanceId: "X2",
        pinName: "IN<1:0>",
        memberId: zero.id,
      },
    }),
  ]);
  await expect(page.locator('[data-role="no-connect-member"]')).toHaveText(
    "IN<0> NC",
  );
  await page.keyboard.press("ControlOrMeta+z");
  expect((await exportedProject(page)).documents[0]!.noConnects).toHaveLength(
    0,
  );
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await clickDrawTool(page, "no-connect");
  await page.getByTestId("terminal-X2-IN<1:0>").click();
  await openSelectionShelf(page);
  await inspector
    .getByLabel("Inspect member", { exact: true })
    .selectOption({ label: "IN<1> · On a Net" });
  const beforeTrace = await exportedProject(page);
  await inspector
    .getByRole("button", { name: "Trace member", exact: true })
    .click();
  await expect(page.getByTestId("net-trace-hops")).toContainText("IN<1>");
  expect((await exportedProject(page)).documents).toEqual(
    beforeTrace.documents,
  );
  await inspector.getByLabel("No Connect member set").fill("IN<0>");
  await inspector
    .getByRole("button", { name: "Clear selected No Connect" })
    .click();
  after = await exportedProject(page);
  expect(after.documents[0]!.noConnects).toHaveLength(0);
});

for (const order of ["ascending", "descending"] as const)
  test(`continuously taps ${order}, ends without wrapping and keeps each completed branch undoable`, async ({
    page,
  }) => {
    await openProject(page, serializeProject(busReuseProject()));
    const before: CircuitProject = await exportedProject(page);
    await clickDrawTool(page, "wire");
    await page.getByTestId("terminal-X2-IN<1:0>").click();
    await page
      .getByRole("button", { name: `Tap ${order}`, exact: true })
      .click();
    const first = order === "ascending" ? "IN<0>" : "IN<1>";
    const second = order === "ascending" ? "IN<1>" : "IN<0>";
    await expect(page.getByLabel("Continuous taps")).toContainText(
      `Next tap: ${first}`,
    );
    await page.getByTestId("terminal-X1-IN<1:0>").click();
    await page.getByLabel("Bus member expression").fill("<99>");
    await expect(
      page.getByRole("button", { name: "Use selection", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Continuous taps")).toContainText(
      `Next tap: ${first}`,
    );
    await page.keyboard.press("l");
    await page
      .getByRole("textbox", { name: "Canvas text editor" })
      .fill("BAD<1:>");
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Continuous taps")).toContainText(
      `Next tap: ${first}`,
    );
    expect((await exportedProject(page)).documents).toEqual(before.documents);
    const authoredSelectors: { id: string; memberId: string; netId: string }[] =
      [];
    for (const [index, y] of [480, 510].entries()) {
      const target = await point(page, 450 - index * 60, y);
      await page.mouse.dblclick(target.x, target.y);
      await expect(page.getByTestId("status")).toContainText("Committed route");
      await expect(page.getByLabel("Continuous taps")).toContainText(
        index ? "All members completed" : `Next tap: ${second}`,
      );
      const current: CircuitProject = await exportedProject(page);
      const added = current.documents[0]!.annotations.filter(
        (annotation) =>
          !before.documents[0]!.annotations.some(
            (old) => old.id === annotation.id,
          ) && !authoredSelectors.some((old) => old.id === annotation.id),
      );
      expect(added).toHaveLength(1);
      const selector = added[0]!;
      expect(selector.binding?.kind).toBe("net-name");
      if (selector.binding?.kind !== "net-name")
        throw new Error("Expected member selector");
      authoredSelectors.push({
        id: selector.id,
        memberId: selector.binding.memberEndpoint!.memberId!,
        netId: selector.netId!,
      });
    }
    const members = before.documents.find((cell) => cell.id === "child")!
      .netlist!.terminals[0]!.signal!.members;
    expect(authoredSelectors.map((selector) => selector.memberId)).toEqual(
      [first, second].map(
        (name) => members.find((member) => member.name === name)!.id,
      ),
    );
    expect(
      new Set(authoredSelectors.map((selector) => selector.netId)).size,
    ).toBe(2);
    await expect(page.getByTestId("active-tool")).toHaveText("wire");
    await page.keyboard.press("Escape");
    const completed = await exportedProject(page);
    expect(completed.documents[0]!.revision).toBe(
      before.documents[0]!.revision + 2,
    );
    await page.keyboard.press("ControlOrMeta+z");
    const undone = await exportedProject(page);
    expect(undone.documents[0]!.routes.length).toBeLessThan(
      completed.documents[0]!.routes.length,
    );
    await page.keyboard.press("ControlOrMeta+Shift+z");
    expect((await exportedProject(page)).documents[0]!.routes).toEqual(
      completed.documents[0]!.routes,
    );
  });

test("intentional fanout keeps its member through invalid choice and cancelled inline naming", async ({
  page,
}) => {
  await openProject(page, serializeProject(busReuseProject()));
  const before: CircuitProject = await exportedProject(page);
  await clickDrawTool(page, "wire");
  await page.getByTestId("terminal-X2-IN<1:0>").click();
  await page
    .getByLabel("Bus connection", { exact: true })
    .selectOption({ label: "Fanout IN<0>" });
  await expect(page.getByLabel("Continuous taps")).toContainText(
    "Fanout: IN<0>",
  );
  await page.getByTestId("terminal-X1-IN<1:0>").click();
  await page.getByLabel("Bus member expression").fill("<99>");
  await expect(
    page.getByRole("button", { name: "Use selection", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Continuous taps")).toContainText(
    "Fanout: IN<0>",
  );
  await page.keyboard.press("l");
  await page
    .getByRole("textbox", { name: "Canvas text editor" })
    .fill("BAD<1:>");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Continuous taps")).toContainText(
    "Fanout: IN<0>",
  );
  for (const [index, y] of [480, 510].entries()) {
    const target = await point(page, 450 - index * 60, y);
    await page.mouse.dblclick(target.x, target.y);
    await expect(page.getByTestId("status")).toContainText("Committed route");
    await expect(page.getByLabel("Continuous taps")).toContainText(
      "Fanout: IN<0>",
    );
  }
  await page.keyboard.press("Escape");
  const after: CircuitProject = await exportedProject(page);
  expect(after.documents[0]!.revision).toBe(before.documents[0]!.revision + 2);
  const selectors = after.documents[0]!.annotations.filter(
    (annotation) =>
      !before.documents[0]!.annotations.some(
        (old) => old.id === annotation.id,
      ) &&
      annotation.binding?.kind === "net-name" &&
      annotation.binding.memberEndpoint,
  );
  expect(selectors).toHaveLength(2);
  expect(selectors[0]!.netId).toBe(selectors[1]!.netId);
});

test("navigates missing members from Issues and preserves copied No Connect through reopen and recovery", async ({
  page,
}) => {
  await openProject(page, serializeProject(busReuseProject()));
  await clickNetlistWorkflowCommand(page, "check-and-save");
  await page.getByTestId("statusbar-issues").click();
  const issue = page
    .getByTestId("project-diagnostics")
    .getByRole("button")
    .filter({ hasText: "Member X2.IN<0> is not connected" });
  await expect(issue).toHaveCount(1);
  await issue.click();
  await expect(page.getByTestId("status")).toContainText("ERC_UNCONNECTED_PIN");
  await expect(
    page.getByLabel("Inspect member", { exact: true }),
  ).not.toHaveValue("");
  await page.getByRole("button", { name: "Mark NoConn", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page.getByTestId("hit-X2").click();
  await copySelectionAt(page, { x: 450, y: 390 });
  const copied: CircuitProject = await exportedProject(page);
  expect(copied.documents[0]!.noConnects).toHaveLength(2);
  const marks = copied.documents[0]!.noConnects;
  expect(new Set(marks.map((mark) => mark.endpoint.instanceId)).size).toBe(2);
  expect(new Set(marks.map((mark) => mark.endpoint.memberId)).size).toBe(1);
  await openProject(page, serializeProject(copied));
  expect((await exportedProject(page)).documents[0]!.noConnects).toEqual(marks);
  await expectRecovered(page, marks[1]!.id);
  await page.reload();
  await expect(page.getByTestId("schematic-canvas")).toBeVisible();
  expect((await exportedProject(page)).documents[0]!.noConnects).toEqual(marks);
});

test("disconnected members cannot trace retained conductors", async ({
  page,
}) => {
  const project = busReuseProject();
  const top = project.documents[0]!;
  const zero = project.documents
    .find((cell) => cell.id === "child")!
    .netlist!.terminals[0]!.signal!.members.find(
      (member) => member.name === "IN<0>",
    )!;
  const proposal = proposeWireIntent(
    top,
    createProjectSymbolResolver(project, builtInSymbols),
    {
      id: "detached-member",
      from: {
        kind: "endpoint",
        endpoint: {
          kind: "terminal",
          instanceId: "X2",
          pinName: "IN<1:0>",
        },
      },
      to: { kind: "free", point: { x: 450, y: 480 } },
    },
  );
  if (typeof proposal === "string") throw new Error(proposal);
  const result = executeProjectTransaction(project, {
    transactionId: "detached-fixture",
    projectId: project.id,
    expectedStructureRevision: project.structureRevision,
    actor: { kind: "human", id: "fixture" },
    edits: [
      {
        kind: "transact_document",
        documentId: top.id,
        expectedRevision: top.revision,
        edits: proposal.edits,
      },
    ],
  });
  if (!result.ok) throw new Error(result.error.message);
  const wired = result.project.documents[0]!;
  const memberNet = wired.nets.find((net) =>
    net.terminals.some(
      (terminal) =>
        terminal.instanceId === "X2" && terminal.memberId === zero.id,
    ),
  )!;
  await openProject(page, serializeProject(result.project));
  await clickDrawTool(page, "no-connect");
  await page.getByTestId("terminal-X2-IN<1:0>").click();
  await openSelectionShelf(page);
  const inspector = page.getByRole("region", { name: "Signal members" });
  await inspector
    .getByLabel("Inspect member", { exact: true })
    .selectOption(zero.id);
  await expect(
    inspector.getByRole("button", { name: "Trace member", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Disconnect endpoint", exact: true })
    .click();
  await expect(
    inspector.getByRole("option", { name: "IN<0> · Unconnected", exact: true }),
  ).toBeAttached();
  await expect(
    inspector.getByRole("button", { name: "Trace member", exact: true }),
  ).toBeDisabled();
  const detached: CircuitProject = await exportedProject(page);
  expect(
    detached.documents[0]!.nets.some((net) => net.id === memberNet.id),
  ).toBe(true);
  expect(
    detached.documents[0]!.nets.flatMap((net) => net.terminals).some(
      (terminal) =>
        terminal.instanceId === "X2" && terminal.memberId === zero.id,
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Mark NoConn", exact: true }).click();
  expect((await exportedProject(page)).documents[0]!.noConnects).toEqual([
    expect.objectContaining({
      endpoint: {
        kind: "terminal",
        instanceId: "X2",
        pinName: "IN<1:0>",
        memberId: zero.id,
      },
    }),
  ]);
});
