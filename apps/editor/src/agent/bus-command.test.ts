import { expect, it } from "vitest";
import { callTool } from "../../../mcp-server/src/tools";
import { liveAgentEditor } from "./live-agent-editor.test-support";

it.each(["pin-id", "pin-reference", "junction"])(
  "selects an ordered subset from semantic %s targets",
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
    const id = terminal.interfaceInstanceIds[0]!;
    const pin = { kind: "pin", instance: { kind: "instance", id }, pin: "P" };
    expect(
      transact("trunk", [
        { kind: "connect", from: pin, to: { kind: "point", x: 100, y: 0 } },
      ]),
    ).toMatchObject({ ok: true });
    const route = controller.document.routes[0]!;
    const end = route.legs.at(-1)!.to;
    if (end.kind !== "endpoint" || end.endpoint.kind !== "junction")
      throw new Error("Missing junction");
    const from =
      sourceKind === "pin-id"
        ? {
            ...pin,
            memberIds: [
              terminal.signal!.members[3]!.id,
              terminal.signal!.members[1]!.id,
            ],
          }
        : sourceKind === "pin-reference"
          ? {
              ...pin,
              instance: terminal.name,
              selectionExpression: "<0,2>",
            }
          : {
              kind: "junction",
              junction: end.endpoint.junctionId,
              selectionExpression: "<0,2>",
            };
    const branch = transact("subset", [
      {
        kind: "connect",
        from,
        to: { kind: "point", x: sourceKind === "junction" ? 100 : 0, y: 100 },
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
    if (!read.ok || !("snapshot" in read))
      throw new Error(JSON.stringify(read));
    const snapshot = read.snapshot.document;
    const subset = snapshot.routes.find(
      (entry) => entry.members?.length === 2,
    )!;
    expect(
      subset.members!.map(
        (member) => snapshot.nets.find((net) => net.id === member.netId)?.name,
      ),
    ).toEqual(["DATA<0>", "DATA<2>"]);
  },
);

it("authors a mixed-name bundle, reordered interior slice and nested slice through circuit_wire with shared history", async () => {
  const { controller, service, client } = liveAgentEditor();
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
  const snapshot = () => {
    const response = service.handle({
      apiVersion: "3.0",
      requestId: `read-${controller.document.revision}`,
      operation: "snapshot",
      documentId: "main",
    });
    if (!response.ok || !("snapshot" in response))
      throw new Error(JSON.stringify(response));
    return response.snapshot.document;
  };
  expect(
    transact("bundle", [
      {
        kind: "place-component",
        symbol: "port",
        reference: "CLK,RESET,DATA<3:0>",
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
  expect(trunk, JSON.stringify(trunk)).toMatchObject({ ok: true });
  const route = snapshot().routes[0]!;
  const tool = async (name: string, args: unknown) => {
    const response = await callTool(name, args, { client });
    return JSON.parse(response.content[0]!.text!);
  };
  expect(await tool("connect", { claimCode: "session-1.code" })).toMatchObject({
    ok: true,
  });
  const slice = await tool("circuit_wire", {
    actions: [
      {
        kind: "connect",
        from: {
          kind: "route-segment",
          routeId: route.id,
          legId: route.legs[0]!.id,
          selectionExpression: "DATA<0,3>,CLK",
          point: { x: 50, y: 0 },
        },
        to: { kind: "point", x: 50, y: 100 },
      },
    ],
  });
  expect(slice, JSON.stringify(slice)).toMatchObject({
    ok: true,
    applied: true,
  });
  const afterSlice = snapshot();
  const branch = afterSlice.routes.find(
    (entry) => entry.members?.length === 3,
  )!;
  const names = (ids: string[], document = snapshot()) =>
    ids.map((id) => document.nets.find((net) => net.id === id)?.name);
  expect(
    names(
      branch.members!.map((member) => member.netId),
      afterSlice,
    ),
  ).toEqual(["DATA<0>", "DATA<3>", "CLK"]);
  const nested = await tool("circuit_wire", {
    actions: [
      {
        kind: "connect",
        from: {
          kind: "route-segment",
          routeId: branch.id,
          legId: branch.legs[0]!.id,
          memberIds: [branch.members![2]!.id, branch.members![0]!.id],
          point: { x: 50, y: 50 },
        },
        to: { kind: "point", x: 150, y: 50 },
      },
    ],
  });
  expect(nested, JSON.stringify(nested)).toMatchObject({
    ok: true,
    applied: true,
  });
  const afterNested = snapshot();
  const nestedRoute = afterNested.routes.find(
    (entry) => entry.members?.length === 2,
  )!;
  expect(
    names(
      nestedRoute.members!.map((member) => member.netId),
      afterNested,
    ),
  ).toEqual(["CLK", "DATA<0>"]);
  expect(afterNested.nets).toHaveLength(6);
  for (const kind of ["undo", "redo"] as const) {
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
    expect(snapshot().routes).toEqual(
      kind === "undo" ? afterSlice.routes : afterNested.routes,
    );
  }
});

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
