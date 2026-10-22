import { executeProjectTransaction, planCreateCellPin } from "@icm/edit-engine";
import { createEmptyProject } from "@icm/model";
import { builtInSymbols, InMemorySymbolResolver } from "@icm/symbols";
import { expect, it } from "vitest";
import { AgentCircuitResponseSchema } from "./schema.js";
import { createAgentCircuitService } from "./service.js";

function fixture() {
  let project = createEmptyProject("bus-agent", "Bus Agent", "child");
  const created = executeProjectTransaction(project, {
    transactionId: "create-pin",
    projectId: project.id,
    expectedStructureRevision: 0,
    actor: { kind: "human", id: "fixture" },
    edits: planCreateCellPin(project, "child", {
      instance: {
        id: "input",
        symbolId: "port",
        placement: { position: { x: 0, y: 0 }, rotation: 0, mirror: "none" },
      },
      terminal: {
        id: "input-terminal",
        name: "DATA<3:0>",
        netId: "input-net",
        direction: "input",
        interfaceInstanceIds: ["input"],
      },
      signalExpression: "DATA<3:0>",
      connectionEdits: [],
    }),
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  if (!created.ok) throw new Error("Could not create fixture");
  project = created.project;
  const service = createAgentCircuitService({
    agentId: "bus-test",
    resolver: new InMemorySymbolResolver(builtInSymbols),
    permissions: {
      snapshot: true,
      render: true,
      sourceSpans: false,
      edit: { geometry: true, connectivity: true, presentation: true },
    },
    store: {
      getDocument: () => project.documents[0]!,
      getProject: () => project,
      commitDocument: (next) => {
        project = { ...project, documents: [next] };
      },
      commitProject: (next) => {
        project = next;
      },
    },
  });
  return {
    service,
    get document() {
      return project.documents[0]!;
    },
    wire(id: string, from: unknown, to: unknown) {
      return service.handle({
        apiVersion: "3.0",
        operation: "transact",
        requestId: id,
        transactionId: id,
        documentId: "child",
        expectedRevision: project.documents[0]!.revision,
        wireIntent: { id, from, to },
      });
    },
    snapshot() {
      const response = service.handle({
        apiVersion: "3.0",
        operation: "snapshot",
        requestId: `snapshot-${project.documents[0]!.revision}`,
        documentId: "child",
      });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      expect(AgentCircuitResponseSchema.safeParse(response).success).toBe(true);
      if (
        !response.ok ||
        response.operation !== "snapshot" ||
        !("snapshot" in response)
      )
        throw new Error("No snapshot");
      return response.snapshot.document;
    },
  };
}

it("draws a declared Cell Pin as one four-member Wire and reads every member back", () => {
  const f = fixture();
  const receipt = f.wire(
    "trunk",
    {
      kind: "endpoint",
      endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
    },
    { kind: "free", point: { x: 100, y: 0 } },
  );
  expect(receipt, JSON.stringify(receipt)).toMatchObject({
    ok: true,
    applied: true,
  });
  expect(f.document.routes[0]?.members).toHaveLength(4);
  const snapshot = f.snapshot();
  const pin = snapshot.instances.find((instance) => instance.id === "input")!
    .pins[0]!;
  expect(pin.netId).toBeNull();
  expect(pin.members?.map((member) => member.name)).toEqual([
    "DATA<3>",
    "DATA<2>",
    "DATA<1>",
    "DATA<0>",
  ]);
  const route = snapshot.routes[0]!;
  expect(route.members).toHaveLength(4);
  expect(new Set(route.members!.map((member) => member.netId)).size).toBe(4);
  expect(snapshot.junctions[0]?.members).toHaveLength(4);
  for (const member of route.members!) {
    const net = snapshot.nets.find((net) => net.id === member.netId)!;
    expect(net.routeIds).toContain(route.id);
    expect(net.junctionIds).toContain(snapshot.junctions[0]!.id);
    expect(net.terminals).toContainEqual({
      instanceId: "input",
      pinName: "P",
      memberId: member.startMemberId,
    });
  }
});

it("keeps an explicitly reordered subset and its nested slice in Agent snapshots", () => {
  const f = fixture();
  const members = f.document.netlist!.terminals[0]!.signal!.members;
  const receipt = f.wire(
    "subset",
    {
      kind: "endpoint",
      endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
      memberIds: [members[3]!.id, members[1]!.id, members[0]!.id],
    },
    { kind: "free", point: { x: 100, y: 0 } },
  );
  expect(receipt, JSON.stringify(receipt)).toMatchObject({
    ok: true,
    applied: true,
  });
  const subset = f
    .snapshot()
    .routes.find((route) => route.id === "subset-route")!;
  expect(subset.members?.map((member) => member.startMemberId)).toEqual([
    members[3]!.id,
    members[1]!.id,
    members[0]!.id,
  ]);
  const nested = f.wire(
    "nested",
    {
      kind: "route-segment",
      routeId: subset.id,
      legId: subset.legs[0]!.id,
      point: { x: 50, y: 0 },
      memberIds: [subset.members![2]!.id, subset.members![0]!.id],
    },
    { kind: "free", point: { x: 50, y: 100 } },
  );
  expect(nested, JSON.stringify(nested)).toMatchObject({
    ok: true,
    applied: true,
  });
  const snapshot = f.snapshot();
  const route = snapshot.routes.find((route) => route.id === "nested-route")!;
  expect(
    route.members?.map(
      (member) => snapshot.nets.find((net) => net.id === member.netId)?.name,
    ),
  ).toEqual(["DATA<3>", "DATA<0>"]);
  expect(snapshot.nets).toHaveLength(4);
});

it("takes the selected member from a bus endpoint without naming or joining another bit", () => {
  const f = fixture();
  const members = f.document.netlist!.terminals[0]!.signal!.members;
  expect(
    f.wire(
      "trunk",
      {
        kind: "endpoint",
        endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
      },
      { kind: "free", point: { x: 100, y: 0 } },
    ),
  ).toMatchObject({ ok: true });
  const receipt = f.wire(
    "take-bit-two",
    {
      kind: "endpoint",
      endpoint: {
        kind: "junction",
        junctionId: "trunk-to-junction",
        memberId: members[1]!.id,
      },
    },
    { kind: "free", point: { x: 100, y: 100 } },
  );
  expect(receipt, JSON.stringify(receipt)).toMatchObject({
    ok: true,
    applied: true,
  });
  const snapshot = f.snapshot();
  expect(snapshot.nets).toHaveLength(4);
  const branch = snapshot.routes.find(
    (route) => route.id === "take-bit-two-route",
  )!;
  const selected = snapshot.nets.find((net) => net.name === "DATA<2>")!;
  expect(branch.netId).toBe(selected.id);
  const label = snapshot.annotations.find(
    (annotation) => annotation.id === "take-bit-two-route-selector",
  )!;
  expect(label.resolvedText).toBe("DATA<2>");
  expect(label.binding).toMatchObject({ kind: "net-name", netId: selected.id });
});

it("selects a bus interior member by its stable route member ID", () => {
  const f = fixture();
  expect(
    f.wire(
      "trunk",
      {
        kind: "endpoint",
        endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
      },
      { kind: "free", point: { x: 100, y: 0 } },
    ),
  ).toMatchObject({ ok: true });
  const trunk = f.snapshot().routes[0]!;
  const receipt = f.wire(
    "interior",
    {
      kind: "route-segment",
      routeId: trunk.id,
      legId: trunk.legs[0]!.id,
      memberId: trunk.members![2]!.id,
      point: { x: 50, y: 0 },
    },
    { kind: "free", point: { x: 50, y: 100 } },
  );
  expect(receipt, JSON.stringify(receipt)).toMatchObject({
    ok: true,
    applied: true,
  });
  const snapshot = f.snapshot();
  expect(snapshot.nets).toHaveLength(4);
  const branch = snapshot.routes.find(
    (route) => route.id === "interior-route",
  )!;
  expect(branch.members).toBeUndefined();
  expect(snapshot.nets.find((net) => net.id === branch.netId)?.name).toBe(
    "DATA<1>",
  );
  expect(
    snapshot.annotations.find(
      (annotation) => annotation.id === "interior-route-selector",
    )?.resolvedText,
  ).toBe("DATA<1>");
});

it.each(["named-tap", "named-net", "terminal-member"])(
  "resolves %s to one member instead of the aggregate's first net",
  (selector) => {
    const f = fixture();
    expect(
      f.wire(
        "trunk",
        {
          kind: "endpoint",
          endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
        },
        { kind: "free", point: { x: 100, y: 0 } },
      ),
    ).toMatchObject({ ok: true });
    const selected = f.document.netlist!.terminals[0]!.signal!.members[3]!;
    const from =
      selector === "named-net"
        ? { kind: "net", net: "DATA<0>" }
        : {
            kind: "wire-at",
            point: { x: 50, y: 0 },
            ...(selector === "named-tap"
              ? { net: "DATA<0>" }
              : {
                  member: {
                    instanceId: "input",
                    pinName: "P",
                    memberId: selected.id,
                  },
                }),
          };
    const receipt = f.wire("selected", from, {
      kind: "free",
      point: { x: 50, y: 100 },
    });
    expect(receipt, JSON.stringify(receipt)).toMatchObject({
      ok: true,
      applied: true,
    });
    const snapshot = f.snapshot();
    expect(snapshot.nets).toHaveLength(4);
    const branch = snapshot.routes.find(
      (route) => route.id === "selected-route",
    )!;
    expect(branch.members).toBeUndefined();
    expect(snapshot.nets.find((net) => net.id === branch.netId)?.name).toBe(
      "DATA<0>",
    );
  },
);

it("keeps ordered mappings in the lightweight geometry projection", () => {
  const f = fixture();
  expect(
    f.wire(
      "trunk",
      {
        kind: "endpoint",
        endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
      },
      { kind: "free", point: { x: 100, y: 0 } },
    ),
  ).toMatchObject({ ok: true });
  const response = f.service.handle({
    apiVersion: "3.0",
    operation: "snapshot",
    requestId: "geometry",
    documentId: "child",
    projection: "geometry",
    geometryIds: ["trunk-route", "trunk-to-junction"],
  });
  expect(response.ok, JSON.stringify(response)).toBe(true);
  expect(AgentCircuitResponseSchema.safeParse(response).success).toBe(true);
  if (!response.ok || !("objects" in response)) throw new Error("No geometry");
  expect(response.objects).toEqual([
    expect.objectContaining({
      id: "trunk-route",
      members: f.document.routes[0]!.members,
    }),
    expect.objectContaining({
      id: "trunk-to-junction",
      members: f.document.junctions[0]!.members,
    }),
  ]);
});

it("keeps two selected bits when one Agent batch splits their original trunk at the same point", () => {
  const f = fixture();
  expect(
    f.wire(
      "trunk",
      {
        kind: "endpoint",
        endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
      },
      { kind: "free", point: { x: 100, y: 0 } },
    ),
  ).toMatchObject({ ok: true });
  const trunk = f.snapshot().routes[0]!;
  const receipt = f.service.handle({
    apiVersion: "3.0",
    operation: "transact",
    requestId: "batch",
    transactionId: "batch",
    documentId: "child",
    expectedRevision: f.document.revision,
    wireIntent: [2, 3].map((index, branch) => ({
      id: `branch-${branch}`,
      from: {
        kind: "route-segment",
        routeId: trunk.id,
        legId: trunk.legs[0]!.id,
        memberId: trunk.members![index]!.id,
        point: { x: 50, y: 0 },
      },
      to: { kind: "free", point: { x: 50, y: branch ? -100 : 100 } },
    })),
  });
  expect(receipt, JSON.stringify(receipt)).toMatchObject({
    ok: true,
    applied: true,
  });
  const snapshot = f.snapshot();
  expect(snapshot.nets).toHaveLength(4);
  for (const [id, name] of [
    ["branch-0-route", "DATA<1>"],
    ["branch-1-route", "DATA<0>"],
  ]) {
    const route = snapshot.routes.find((route) => route.id === id)!;
    expect(route.members).toBeUndefined();
    expect(snapshot.nets.find((net) => net.id === route.netId)?.name).toBe(
      name,
    );
  }
});

it("preserves ordered subsets when a wire batch rebases a second tap onto the first split", () => {
  const f = fixture();
  expect(
    f.wire(
      "trunk",
      {
        kind: "endpoint",
        endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
      },
      { kind: "free", point: { x: 100, y: 0 } },
    ),
  ).toMatchObject({ ok: true });
  const trunk = f.snapshot().routes[0]!;
  const receipt = f.service.handle({
    apiVersion: "3.0",
    operation: "transact",
    requestId: "subset-batch",
    transactionId: "subset-batch",
    documentId: "child",
    expectedRevision: f.document.revision,
    wireIntent: [
      [3, 1],
      [0, 2],
    ].map((indices, branch) => ({
      id: `subset-${branch}`,
      from: {
        kind: "route-segment",
        routeId: trunk.id,
        legId: trunk.legs[0]!.id,
        memberIds: indices.map((index) => trunk.members![index]!.id),
        point: { x: 50, y: 0 },
      },
      to: { kind: "free", point: { x: 50, y: branch ? -100 : 100 } },
    })),
  });
  expect(receipt, JSON.stringify(receipt)).toMatchObject({
    ok: true,
    applied: true,
  });
  const snapshot = f.snapshot();
  expect(
    ["subset-0-route", "subset-1-route"].map((id) =>
      snapshot.routes
        .find((route) => route.id === id)!
        .members?.map(
          (member) =>
            snapshot.nets.find((net) => net.id === member.netId)?.name,
        ),
    ),
  ).toEqual([
    ["DATA<0>", "DATA<2>"],
    ["DATA<3>", "DATA<1>"],
  ]);
  expect(snapshot.nets).toHaveLength(4);
});

it.each(["unknown", "duplicate", "empty", "conflict", "expression", "width"])(
  "refuses a %s subset after a valid tap without committing any part of the batch",
  (failure) => {
    const f = fixture();
    expect(
      f.wire(
        "trunk",
        {
          kind: "endpoint",
          endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
        },
        { kind: "free", point: { x: 100, y: 0 } },
      ),
    ).toMatchObject({ ok: true });
    const trunk = f.snapshot().routes[0]!;
    const before = structuredClone(f.document);
    const ids = trunk.members!.map((member) => member.id);
    const selection =
      failure === "expression"
        ? { selectionExpression: "UNKNOWN<1:0>" }
        : {
            memberIds:
              failure === "unknown"
                ? [ids[0], "missing"]
                : failure === "duplicate"
                  ? [ids[0], ids[0]]
                  : failure === "empty"
                    ? []
                    : [ids[1], ids[0]],
            ...(failure === "conflict" ? { memberId: ids[0] } : {}),
          };
    const from = {
      kind: "route-segment",
      routeId: trunk.id,
      legId: trunk.legs[0]!.id,
      point: { x: 50, y: 0 },
    };
    const receipt = f.service.handle({
      apiVersion: "3.0",
      operation: "transact",
      requestId: "invalid-subset",
      transactionId: "invalid-subset",
      documentId: "child",
      expectedRevision: before.revision,
      wireIntent: [
        {
          id: "valid",
          from: { ...from, memberIds: [ids[0], ids[1]] },
          to: { kind: "free", point: { x: 50, y: 100 } },
        },
        {
          id: "invalid",
          from: { ...from, ...selection },
          to:
            failure === "width"
              ? {
                  kind: "endpoint",
                  endpoint: {
                    kind: "junction",
                    junctionId: "trunk-to-junction",
                  },
                }
              : { kind: "free", point: { x: 50, y: -100 } },
        },
      ],
    });
    expect(receipt.ok, JSON.stringify(receipt)).toBe(false);
    expect(f.document).toEqual(before);
  },
);

it.each(["endpoint", "route-segment", "stale"])(
  "refuses an invalid %s selection without leaving a split, branch or selector",
  (kind) => {
    const f = fixture();
    expect(
      f.wire(
        "trunk",
        {
          kind: "endpoint",
          endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
        },
        { kind: "free", point: { x: 100, y: 0 } },
      ),
    ).toMatchObject({ ok: true });
    const before = structuredClone(f.document);
    const route = before.routes[0]!;
    const from =
      kind === "endpoint"
        ? {
            kind: "endpoint",
            endpoint: {
              kind: "junction",
              junctionId: "trunk-to-junction",
              memberId: "missing",
            },
          }
        : {
            kind: "route-segment",
            routeId: route.id,
            legId: route.legs[0]!.id,
            memberId: kind === "stale" ? route.members![1]!.id : "missing",
            point: { x: 50, y: 0 },
          };
    const receipt = f.service.handle({
      apiVersion: "3.0",
      operation: "transact",
      requestId: "invalid",
      transactionId: "invalid",
      documentId: "child",
      expectedRevision: before.revision - (kind === "stale" ? 1 : 0),
      wireIntent: {
        id: "invalid",
        from,
        to: { kind: "free", point: { x: 50, y: 100 } },
      },
    });
    expect(receipt.ok, JSON.stringify(receipt)).toBe(false);
    expect(f.document).toEqual(before);
  },
);

it.each(["scalar", "bus", "subset"])(
  "refuses a %s running along another bit after leaving their shared bus endpoint",
  (kind) => {
    const f = fixture();
    const members = f.document.netlist!.terminals[0]!.signal!.members;
    expect(
      f.wire(
        "trunk",
        {
          kind: "endpoint",
          endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
        },
        { kind: "free", point: { x: 100, y: 0 } },
      ),
    ).toMatchObject({ ok: true });
    const first = f.wire(
      "first-bit",
      {
        kind: "endpoint",
        ...(kind === "subset"
          ? { memberIds: [members[0]!.id, members[1]!.id] }
          : {}),
        endpoint: {
          kind: "junction",
          junctionId: "trunk-to-junction",
          ...(kind !== "subset" ? { memberId: members[0]!.id } : {}),
        },
      },
      { kind: "free", point: { x: 100, y: 100 } },
    );
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    const before = structuredClone(f.document);
    const receipt = f.service.handle({
      apiVersion: "3.0",
      operation: "transact",
      requestId: "overlap",
      transactionId: "overlap",
      documentId: "child",
      expectedRevision: before.revision,
      wireIntent: {
        id: "overlap",
        from: {
          kind: "endpoint",
          ...(kind === "subset"
            ? { memberIds: [members[2]!.id, members[3]!.id] }
            : {}),
          endpoint: {
            kind: "junction",
            junctionId: "trunk-to-junction",
            ...(kind === "scalar" ? { memberId: members[1]!.id } : {}),
          },
        },
        to: { kind: "free", point: { x: 200, y: -100 } },
        waypoints: [
          { x: 100, y: 40 },
          { x: 140, y: 40 },
          { x: 140, y: -100 },
        ],
      },
    });
    expect(receipt, JSON.stringify(receipt)).toMatchObject({
      ok: false,
      error: { code: "EDIT_PRECONDITION" },
    });
    expect(f.document).toEqual(before);
  },
);

it("retains reversed subset order when clearance shortens its overlap with an existing slice", () => {
  const f = fixture();
  const members = f.document.netlist!.terminals[0]!.signal!.members;
  const endpoint = {
    kind: "endpoint",
    endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
  };
  expect(
    f.wire(
      "slice",
      { ...endpoint, memberIds: [members[0]!.id, members[1]!.id] },
      { kind: "free", point: { x: 100, y: 0 } },
    ),
  ).toMatchObject({ ok: true });
  const receipt = f.service.handle({
    apiVersion: "3.0",
    operation: "transact",
    requestId: "reversed",
    transactionId: "reversed",
    documentId: "child",
    expectedRevision: f.document.revision,
    wireIntent: {
      id: "reversed",
      from: { ...endpoint, memberIds: [members[1]!.id, members[0]!.id] },
      to: { kind: "free", point: { x: 50, y: 100 } },
      waypoints: [{ x: 50, y: 0 }],
    },
  });
  expect(receipt, JSON.stringify(receipt)).toMatchObject({
    ok: true,
    applied: true,
  });
  const snapshot = f.snapshot();
  const branch = snapshot.routes.find(
    (route) => route.id === "reversed-route",
  )!;
  expect(
    branch.members?.map(
      (member) => snapshot.nets.find((net) => net.id === member.netId)?.name,
    ),
  ).toEqual(["DATA<2>", "DATA<3>"]);
});

it("connects a selected bus interior member to a real scalar device terminal", () => {
  const f = fixture();
  expect(
    f.service.handle({
      apiVersion: "3.0",
      operation: "transact",
      requestId: "resistor",
      transactionId: "resistor",
      documentId: "child",
      expectedRevision: f.document.revision,
      edits: [
        {
          kind: "add_instance",
          instance: {
            id: "load",
            symbolId: "resistor",
            reference: "R1",
            placement: {
              position: { x: 50, y: 120 },
              rotation: 0,
              mirror: "none",
            },
          },
        },
      ],
    }),
  ).toMatchObject({ ok: true });
  expect(
    f.wire(
      "trunk",
      {
        kind: "endpoint",
        endpoint: { kind: "terminal", instanceId: "input", pinName: "P" },
      },
      { kind: "free", point: { x: 100, y: 0 } },
    ),
  ).toMatchObject({ ok: true });
  const trunk = f.snapshot().routes[0]!;
  const receipt = f.wire(
    "load-wire",
    {
      kind: "route-segment",
      routeId: trunk.id,
      legId: trunk.legs[0]!.id,
      memberId: trunk.members![2]!.id,
      point: { x: 50, y: 0 },
    },
    {
      kind: "endpoint",
      endpoint: { kind: "terminal", instanceId: "load", pinName: "1" },
    },
  );
  expect(receipt, JSON.stringify(receipt)).toMatchObject({
    ok: true,
    applied: true,
  });
  const snapshot = f.snapshot();
  const net = snapshot.nets.find((net) => net.name === "DATA<1>")!;
  expect(net.terminals).toContainEqual({ instanceId: "load", pinName: "1" });
  expect(snapshot.nets).toHaveLength(4);
});
