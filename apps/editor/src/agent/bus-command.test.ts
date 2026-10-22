import { expect, it } from "vitest";
import { liveAgentEditor } from "./live-agent-editor.test-support";

it.each(["pin", "junction", "route-segment"])(
  "uses semantic connect actions to select a %s member with shared undo",
  (sourceKind) => {
    const { controller, service } = liveAgentEditor();
    const transact = (id: string, actions: unknown[]) =>
      service.handle({
        apiVersion: "3.0",
        requestId: id,
        transactionId: id,
        operation: "transact",
        documentId: "main",
        expectedRevision: controller.document.revision,
        expectedStructureRevision: controller.project.structureRevision,
        actions,
      });
    expect(
      transact("create", [
        {
          kind: "place-component",
          symbol: "port",
          reference: "DATA<3:0>",
          direction: "input",
          position: { x: 0, y: 0 },
        },
      ]),
    ).toMatchObject({ ok: true });
    const terminal = controller.document.netlist!.terminals[0]!;
    const pin = {
      kind: "pin",
      instance: { kind: "instance", id: terminal.interfaceInstanceIds[0]! },
      pin: "P",
    };
    const trunk = transact("trunk", [
      { kind: "connect", from: pin, to: { kind: "point", x: 100, y: 0 } },
    ]);
    expect(trunk, JSON.stringify(trunk)).toMatchObject({
      ok: true,
      applied: true,
    });
    expect(controller.document.routes[0]!.members).toHaveLength(4);
    const route = controller.document.routes[0]!;
    const end = route.legs.at(-1)!.to;
    if (end.kind !== "endpoint" || end.endpoint.kind !== "junction")
      throw new Error("Missing aggregate junction");
    const from =
      sourceKind === "pin"
        ? { ...pin, memberId: terminal.signal!.members[2]!.id }
        : sourceKind === "junction"
          ? {
              kind: "junction",
              junction: end.endpoint.junctionId,
              memberId: route.members![2]!.endMemberId,
            }
          : {
              kind: "route-segment",
              routeId: route.id,
              legId: route.legs[0]!.id,
              memberId: route.members![2]!.id,
              point: { x: 50, y: 0 },
            };
    const branch = transact("branch", [
      {
        kind: "connect",
        from,
        to: {
          kind: "point",
          x: sourceKind === "pin" ? 0 : sourceKind === "junction" ? 100 : 50,
          y: 100,
        },
      },
    ]);
    expect(branch, JSON.stringify(branch)).toMatchObject({
      ok: true,
      applied: true,
    });
    const read = service.handle({
      apiVersion: "3.0",
      requestId: "read",
      operation: "snapshot",
      documentId: "main",
    });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    if (!read.ok || read.operation !== "snapshot" || !("snapshot" in read))
      throw new Error("No snapshot");
    const scalar = read.snapshot.document.routes.find(
      (route) => !route.members,
    )!;
    expect(
      read.snapshot.document.nets.find((net) => net.id === scalar.netId)?.name,
    ).toBe("DATA<1>");
    expect(read.snapshot.document.nets).toHaveLength(4);
    for (const [kind, count] of [
      ["undo", 1],
      ["redo", sourceKind === "route-segment" ? 3 : 2],
    ] as const) {
      expect(
        service.handle({
          apiVersion: "3.0",
          requestId: kind,
          transactionId: kind,
          operation: "transact",
          documentId: "main",
          expectedRevision: controller.document.revision,
          edits: [{ kind }],
        }),
      ).toMatchObject({ ok: true, applied: true });
      expect(controller.document.routes).toHaveLength(count);
    }
  },
);
