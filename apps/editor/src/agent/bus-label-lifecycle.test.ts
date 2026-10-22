import { expect, it } from "vitest";
import { createEmptyProject, createRoutePath } from "@icm/model";
import { parseProject, serializeProject } from "@icm/project-protocol";
import { liveAgentEditor } from "./live-agent-editor.test-support";

it.each(["CLOCK", "C".repeat(140)])(
  "migrates a live Agent Label to %s with explicit mapping and restores its complete document in one Undo",
  (clockName) => {
    const project = createEmptyProject("label-agent", "Label Agent", "main");
    const document = project.documents[0]!;
    document.nets.push(
      { id: "n0", terminals: [] },
      { id: "n1", terminals: [] },
    );
    document.junctions.push(
      ...["a", "b"].map((id, index) => ({
        id,
        netId: "n0",
        position: { x: index * 100, y: 0 },
        members: [
          { id: `${id}0`, netId: "n0" },
          { id: `${id}1`, netId: "n1" },
        ],
      })),
    );
    document.routes.push(
      createRoutePath({
        id: "wire",
        netId: "n0",
        start: { kind: "junction", junctionId: "a" },
        end: { kind: "junction", junctionId: "b" },
        bends: [],
        modes: ["manual"],
        members: [
          { id: "m0", netId: "n0", startMemberId: "a0", endMemberId: "b0" },
          { id: "m1", netId: "n1", startMemberId: "a1", endMemberId: "b1" },
        ],
      }),
    );
    document.annotations.push({
      id: "label",
      kind: "net-label",
      netId: "n0",
      binding: { kind: "net-name", netId: "n0" },
      anchor: { kind: "free", position: { x: 50, y: -10 } },
      alignment: "middle",
      rotation: 0,
      locked: false,
    });
    document.connectivityEvidence.push({
      id: "claim",
      kind: "name-claim",
      netId: "n0",
      name: "CLK,RESET",
      signal: {
        expression: "CLK,RESET",
        members: [
          { id: "m0", name: "CLK", netId: "n0" },
          { id: "m1", name: "RESET", netId: "n1" },
        ],
      },
      owner: { kind: "net-label", annotationId: "label" },
      scope: "local",
    });
    document.junctions.push({
      id: "scalar-tap",
      netId: "n0",
      position: { x: 0, y: 100 },
    });
    document.routes.unshift(
      createRoutePath({
        id: "tap",
        netId: "n0",
        start: { kind: "junction", junctionId: "a", memberId: "a0" },
        end: { kind: "junction", junctionId: "scalar-tap" },
        bends: [],
        modes: ["manual"],
      }),
    );
    const { controller, service } = liveAgentEditor({ project });
    const before = structuredClone(controller.document);
    const response = service.handle({
      apiVersion: "3.0",
      requestId: "rename",
      transactionId: "rename",
      operation: "transact",
      documentId: "main",
      expectedRevision: controller.document.revision,
      expectedStructureRevision: controller.project.structureRevision,
      command: {
        kind: "set-net-label",
        annotationId: "label",
        netId: "n0",
        text: `RST,${clockName}`,
        memberMap: { m0: clockName, m1: "RST" },
      },
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(controller.document.annotations[0]!.binding).toEqual({
      kind: "net-name",
      netId: "n1",
    });
    expect(
      controller.document.routes
        .find((route) => route.id === "wire")!
        .members!.map((member) => member.id),
    ).toEqual(["m1", "m0"]);

    const beforePermutation = structuredClone(controller.document);
    for (const memberMap of [{ unknown: "RST" }, { m0: "RST" }]) {
      const invalid = service.handle({
        apiVersion: "3.0",
        requestId: `invalid-${Object.keys(memberMap)[0]}`,
        transactionId: `invalid-${Object.keys(memberMap)[0]}`,
        operation: "transact",
        documentId: "main",
        expectedRevision: controller.document.revision,
        expectedStructureRevision: controller.project.structureRevision,
        command: {
          kind: "set-net-label",
          annotationId: "label",
          netId: "n1",
          text: `RST,${clockName}`,
          memberMap,
        },
      });
      expect(invalid.ok).toBe(false);
      expect(controller.document).toEqual(beforePermutation);
    }
    const permuted = service.handle({
      apiVersion: "3.0",
      requestId: "permutation",
      transactionId: "permutation",
      operation: "transact",
      documentId: "main",
      expectedRevision: controller.document.revision,
      expectedStructureRevision: controller.project.structureRevision,
      command: {
        kind: "set-net-label",
        annotationId: "label",
        netId: "n1",
        text: `RST,${clockName}`,
        memberMap: { m0: "RST", m1: clockName },
      },
    });
    expect(permuted.ok, JSON.stringify(permuted)).toBe(true);
    expect(
      controller.document.routes
        .find((route) => route.id === "wire")!
        .members!.map((member) => member.id),
    ).toEqual(["m0", "m1"]);
    const reopened = parseProject(serializeProject(controller.project))
      .documents[0]!;
    expect(
      reopened.routes.find((route) => route.id === "wire")!.members,
    ).toEqual(before.routes.find((route) => route.id === "wire")!.members);
    expect(
      reopened.connectivityEvidence.find((item) => item.kind === "name-claim"),
    ).toMatchObject({
      name: `RST,${clockName}`,
      signal: {
        expression: `RST,${clockName}`,
        members: [
          { id: "m0", name: "RST", netId: "n0" },
          { id: "m1", name: clockName, netId: "n1" },
        ],
      },
    });
    expect(controller.transact([{ kind: "undo" }]).ok).toBe(true);
    expect({
      ...controller.document,
      revision: beforePermutation.revision,
    }).toEqual(beforePermutation);
    expect(controller.transact([{ kind: "undo" }]).ok).toBe(true);
    expect({ ...controller.document, revision: before.revision }).toEqual(
      before,
    );
    const reduced = service.handle({
      apiVersion: "3.0",
      requestId: "reduce",
      transactionId: "reduce",
      operation: "transact",
      documentId: "main",
      expectedRevision: controller.document.revision,
      expectedStructureRevision: controller.project.structureRevision,
      command: {
        kind: "set-net-label",
        annotationId: "label",
        netId: "n0",
        text: "CLK,RESET,ENABLE",
      },
    });
    expect(reduced.ok, JSON.stringify(reduced)).toBe(true);
    if (reduced.ok && reduced.operation === "transact") {
      const changed = [
        ...controller.document.routes,
        ...controller.document.junctions,
      ].filter(
        (object) =>
          ![...before.routes, ...before.junctions].some(
            (old) =>
              old.id === object.id &&
              JSON.stringify(old) === JSON.stringify(object),
          ),
      );
      expect(changed.length).toBeGreaterThan(1);
      expect(reduced.diff.changedObjectIds).toEqual(
        expect.arrayContaining(changed.map((object) => object.id)),
      );
    }
  },
);
