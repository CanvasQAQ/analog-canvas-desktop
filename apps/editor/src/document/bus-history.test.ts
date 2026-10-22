import { expect, it } from "vitest";
import { createEmptyProject } from "@icm/model";
import {
  planCreateCellPin,
  createFreeWireAnchor,
  proposeWireCommit,
} from "@icm/edit-engine";
import { serializeProject, parseProject } from "@icm/project-protocol";
import { EditorDocumentController } from "./document-controller";
import { planNameSignalRoute } from "../../../../packages/edit-engine/src/signal-wire.test-support";

it("undoes and redoes complete bus authoring without orphaned mappings or selectors", () => {
  const controller = new EditorDocumentController(
    createEmptyProject("bus-history", "Bus", "cell"),
  );
  const commit = (
    edits: Parameters<typeof controller.dispatchProjectTransaction>[0]["edits"],
  ) =>
    controller.dispatchProjectTransaction({
      transactionId: "bus",
      projectId: controller.project.id,
      expectedStructureRevision: controller.project.structureRevision,
      actor: { kind: "human", id: "test" },
      edits,
    });
  expect(
    commit(
      planCreateCellPin(controller.project, "cell", {
        instance: {
          id: "pin",
          symbolId: "port",
          placement: { position: { x: 0, y: 0 }, rotation: 0, mirror: "none" },
        },
        terminal: {
          id: "terminal",
          name: "IN<3:0>",
          netId: "input",
          direction: "input",
          interfaceInstanceIds: ["pin"],
        },
        connectionEdits: [],
        signalExpression: "IN<3:0>",
      }),
    ).ok,
  ).toBe(true);
  const members = controller.document.netlist!.terminals[0]!.signal!.members;
  const endpoint = {
    kind: "terminal" as const,
    instanceId: "pin",
    pinName: "P",
  };
  const wire = proposeWireCommit(
    {
      endpoint,
      netId: members[0]!.netId,
      members,
      preludeEdits: [],
      connection: {
        endpoint,
        contactPoint: { x: 0, y: 0 },
        gridLanding: { x: 0, y: 0 },
        outward: null,
        escapePath: [],
      },
    },
    createFreeWireAnchor({ x: 100, y: 0 }, members[0]!.netId, false, "end"),
    [],
    { routeId: "trunk", newNetId: "unused" },
  );
  expect(controller.transact(wire.edits).ok).toBe(true);
  expect(
    commit(
      planNameSignalRoute(
        controller.project,
        "cell",
        "trunk",
        "IN<3:0>",
        "name",
      ),
    ).ok,
  ).toBe(true);
  const completed = serializeProject(controller.project);
  for (let i = 0; i < 3; i++)
    expect(controller.transact([{ kind: "undo" }]).ok).toBe(true);
  expect(controller.document.nets).toEqual([]);
  expect(controller.document.junctions).toEqual([]);
  expect(controller.document.routes).toEqual([]);
  expect(controller.document.annotations).toEqual([]);
  for (let i = 0; i < 3; i++)
    expect(controller.transact([{ kind: "redo" }]).ok).toBe(true);
  const expected = parseProject(completed).documents[0]!;
  expect(controller.document.routes).toEqual(expected.routes);
  expect(controller.document.netlist).toEqual(expected.netlist);
  expect(controller.document.connectivityEvidence).toEqual(
    expected.connectivityEvidence,
  );
  expect(controller.document.annotations).toEqual(expected.annotations);
  const before = controller.project;
  const stale = controller.dispatchProjectTransaction({
    transactionId: "stale",
    projectId: before.id,
    expectedStructureRevision: 0,
    actor: { kind: "human", id: "test" },
    edits: [],
  });
  expect(stale.ok).toBe(false);
  expect(controller.project).toBe(before);
});
