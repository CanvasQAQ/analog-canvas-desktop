import { expect, it } from "vitest";
import {
  createEmptyProject,
  createEmptyDocument,
  routeEnd,
  flattenRichText,
  type CircuitProject,
} from "@icm/model";
import { resolveAnnotationText } from "@icm/derived";
import {
  executeProjectTransaction,
  planCreateCellPin,
  planRenameCellTerminal,
  proposeWireIntent,
  type ProjectStructureEdit,
} from "@icm/edit-engine";
import {
  builtInSymbols,
  createProjectSymbolResolver,
  createBlockSymbol,
  hierarchicalSymbolId,
} from "@icm/symbols";
import { parseProject, serializeProject } from "@icm/project-protocol";
import {
  captureProjectCopy,
  planProjectCopyPlacement,
  applyProjectCopyPlacement,
} from "./project-copy";
import {
  encodeCircuitClipboard,
  decodeCircuitClipboard,
} from "./system-clipboard";

function transact(project: CircuitProject, edits: ProjectStructureEdit[]) {
  const result = executeProjectTransaction(project, {
    transactionId: `copy-fixture-${project.structureRevision}`,
    projectId: project.id,
    expectedStructureRevision: project.structureRevision,
    actor: { kind: "human", id: "test" },
    edits,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.project;
}
function fixture() {
  let project = createEmptyProject("bus-source", "Bus source");
  const documentId = project.documents[0]!.id;
  project = transact(
    project,
    planCreateCellPin(project, documentId, {
      instance: {
        id: "port",
        symbolId: "port",
        placement: { position: { x: 0, y: 0 }, rotation: 0, mirror: "none" },
      },
      terminal: {
        id: "formal",
        name: "DATA<3:0>",
        netId: "data",
        direction: "input",
        interfaceInstanceIds: ["port"],
      },
      signalExpression: "DATA<3:0>",
      connectionEdits: [],
    }),
  );
  const document = project.documents[0]!;
  const wire = proposeWireIntent(
    document,
    createProjectSymbolResolver(project, builtInSymbols),
    {
      id: "trunk",
      from: {
        kind: "endpoint",
        endpoint: { kind: "terminal", instanceId: "port", pinName: "P" },
      },
      to: { kind: "free", point: { x: 200, y: 0 } },
    },
  );
  if (typeof wire === "string") throw new Error(wire);
  return transact(project, [
    {
      kind: "transact_document",
      documentId,
      expectedRevision: document.revision,
      edits: wire.edits,
    },
  ]);
}

it("copies unwired selections of vector Pins without carrying their invisible source joins", () => {
  let source = fixture();
  const id = source.documents[0]!.id;
  source = transact(
    source,
    planCreateCellPin(source, id, {
      instance: {
        id: "peer",
        symbolId: "port",
        placement: { position: { x: 500, y: 0 }, rotation: 0, mirror: "none" },
      },
      terminal: {
        id: "peer-formal",
        name: "DATA<3:0>",
        netId: "peer-net",
        direction: "input",
        interfaceInstanceIds: ["peer"],
      },
      signalExpression: "DATA<3:0>",
      connectionEdits: [],
    }),
  );
  const document = source.documents[0]!;
  const members = document.netlist!.terminals[0]!.signal!.members;
  const peers = document.netlist!.terminals[1]!.signal!.members;
  source = transact(source, [
    {
      kind: "transact_document",
      documentId: id,
      expectedRevision: document.revision,
      edits: members.map((member, index) => ({
        kind: "connect_endpoints" as const,
        from: {
          kind: "terminal" as const,
          instanceId: "port",
          pinName: "P",
          memberId: member.id,
        },
        to: {
          kind: "terminal" as const,
          instanceId: "peer",
          pinName: "P",
          memberId: peers[index]!.id,
        },
      })),
    },
  ]);
  const clipboard = captureProjectCopy(source, source.documents[0]!, {
    instanceIds: ["port", "peer"],
    routeIds: [],
    junctionIds: [],
    annotationIds: [],
    draftingIds: [],
  })!;
  const destination = createEmptyProject("isolated-pins", "Target");
  const copied = applyProjectCopyPlacement(
    planProjectCopyPlacement(
      destination,
      destination.documents[0]!,
      clipboard,
      { x: 0, y: 0 },
      1,
    ),
  );
  const cell = copied.documents[0]!;
  expect(cell.routes).toHaveLength(0);
  const copiedNets = cell.netlist!.terminals.flatMap((terminal) =>
    terminal.signal!.members.map((member) => member.netId),
  );
  expect(new Set(copiedNets).size).toBe(8);
  expect(cell.nets.every((net) => net.terminals.length <= 1)).toBe(true);
});

it("copies a bus without its source Pin as four independent open anchor members", () => {
  const source = fixture();
  const document = source.documents[0]!;
  const clipboard = captureProjectCopy(source, document, {
    instanceIds: [],
    routeIds: document.routes.map((route) => route.id),
    junctionIds: [],
    annotationIds: [],
    draftingIds: [],
  })!;
  const destination = createEmptyProject("destination", "Destination");
  const copied = applyProjectCopyPlacement(
    planProjectCopyPlacement(
      destination,
      destination.documents[0]!,
      clipboard,
      { x: 0, y: 200 },
      1,
    ),
  );
  const reopened = parseProject(serializeProject(copied));
  const cell = reopened.documents[0]!;
  expect(cell.instances).toHaveLength(0);
  expect(cell.nets).toHaveLength(4);
  expect(cell.nets.every((net) => net.terminals.length === 0)).toBe(true);
  const route = cell.routes[0]!;
  expect(route.members).toHaveLength(4);
  expect(new Set(route.members!.map((member) => member.netId)).size).toBe(4);
  for (const [index, endpoint] of [route.start, routeEnd(route)].entries()) {
    expect(endpoint.kind).toBe("junction");
    if (endpoint.kind !== "junction") continue;
    const anchor = cell.junctions.find(
      (junction) => junction.id === endpoint.junctionId,
    )!;
    expect(anchor.members).toHaveLength(4);
    expect(
      route.members!.map((member) =>
        index === 0 ? member.startMemberId : member.endMemberId,
      ),
    ).toEqual(anchor.members!.map((member) => member.id));
  }
  expect(serializeProject(parseProject(serializeProject(reopened)))).toBe(
    serializeProject(reopened),
  );
});

it.each(["formal", "caller"])(
  "copies scalar taps without foreign selector references to the omitted %s",
  (owner) => {
    let source = fixture();
    let documentId = source.documents[0]!.id;
    let instanceId = "port";
    let pinName = "P";
    if (owner === "caller") {
      const child = source.documents[0]!;
      const parent = createEmptyDocument("tap-parent", "Tap parent");
      parent.instances.push({
        id: "caller",
        symbolId: hierarchicalSymbolId(child.netlist!.name),
        reference: "X1",
        placement: { position: { x: 200, y: 0 }, rotation: 0, mirror: "none" },
        netlist: {
          binding: { kind: "subcircuit", childDocumentId: child.id },
          parameters: {},
        },
      });
      source = transact(source, [{ kind: "add_document", document: parent }]);
      source = transact(source, [
        {
          kind: "transact_document",
          documentId: parent.id,
          expectedRevision: parent.revision,
          edits: [
            {
              kind: "add_junction",
              junctionId: "existing-member-contact",
              netId: "caller-member-net",
              createNet: true,
              position: { x: 400, y: 0 },
            },
            {
              kind: "connect_endpoints",
              from: {
                kind: "terminal",
                instanceId: "caller",
                pinName: "DATA<3:0>",
                memberId: child.netlist!.terminals[0]!.signal!.members[0]!.id,
              },
              to: { kind: "junction", junctionId: "existing-member-contact" },
            },
          ],
        },
      ]);
      documentId = parent.id;
      instanceId = "caller";
      pinName = "DATA<3:0>";
    }
    const routeIds: string[] = [];
    const tapCount = owner === "caller" ? 1 : 2;
    for (let index = 0; index < tapCount; index++) {
      const document = source.documents.find((cell) => cell.id === documentId)!;
      const branch = proposeWireIntent(
        document,
        createProjectSymbolResolver(source, builtInSymbols),
        {
          id: `scalar-tap-${index}`,
          from: {
            kind: "endpoint",
            endpoint: { kind: "terminal", instanceId, pinName },
            selectionExpression: owner === "caller" ? "DATA<3>" : "DATA<1>",
          },
          to: { kind: "free", point: { x: index * 100, y: 100 } },
        },
      );
      if (typeof branch === "string") throw new Error(branch);
      routeIds.push(branch.routeId!);
      source = transact(source, [
        {
          kind: "transact_document",
          documentId: document.id,
          expectedRevision: document.revision,
          edits: branch.edits,
        },
      ]);
    }
    const original = source.documents.find((cell) => cell.id === documentId)!;
    if (owner === "caller") expect(original.nets).toHaveLength(1);
    const encoded = encodeCircuitClipboard(source, original, {
      instanceIds: [],
      routeIds,
      junctionIds: [],
      annotationIds: [],
      draftingIds: [],
    })!;
    const clipboard = decodeCircuitClipboard(encoded)!;
    const destination = createEmptyProject("tap-target", "Target");
    const copied = applyProjectCopyPlacement(
      planProjectCopyPlacement(
        destination,
        destination.documents[0]!,
        clipboard,
        { x: 100, y: 100 },
        1,
      ),
    );
    const cell = copied.documents[0]!;
    expect(cell.instances).toHaveLength(0);
    expect(cell.routes).toHaveLength(tapCount);
    expect(cell.annotations).toHaveLength(tapCount);
    expect(cell.nets).toHaveLength(4);
    expect(cell.nets.every((net) => net.terminals.length === 0)).toBe(true);
    expect(new Set(cell.routes.map((route) => route.netId)).size).toBe(1);
    for (const annotation of cell.annotations) {
      const binding = annotation.binding;
      expect(binding?.kind).toBe("net-name");
      if (binding?.kind !== "net-name")
        throw new Error("Missing selector binding");
      expect(binding.memberEndpoint?.kind).toBe("junction");
      if (binding.memberEndpoint?.kind !== "junction")
        throw new Error("Selector still references omitted source");
      const selected = binding.memberEndpoint;
      if (annotation.anchor.kind !== "route")
        throw new Error("Missing branch anchor");
      const anchoredRoute = cell.routes.find(
        (route) =>
          annotation.anchor.kind === "route" &&
          route.id === annotation.anchor.routeId,
      )!;
      expect([anchoredRoute.start, routeEnd(anchoredRoute)]).toContainEqual(
        selected,
      );
      expect(
        cell.junctions
          .find((junction) => junction.id === selected.junctionId)
          ?.members?.some((member) => member.id === selected.memberId),
      ).toBe(true);
      expect(flattenRichText(resolveAnnotationText(cell, annotation))).toBe(
        owner === "caller" ? "DATA<3>" : "DATA<1>",
      );
    }
    expect(cell.connectivityEvidence).toEqual([]);
  },
);

it("copies an ordered subset with plural selector bindings to the copied members", () => {
  let source = fixture();
  const document = source.documents[0]!;
  const trunk = document.routes[0]!;
  const branch = proposeWireIntent(
    document,
    createProjectSymbolResolver(source, builtInSymbols),
    {
      id: "slice",
      from: {
        kind: "route-segment",
        routeId: trunk.id,
        legId: trunk.legs[0]!.id,
        point: { x: 100, y: 0 },
        selectionExpression: "DATA<3,1>",
      },
      to: { kind: "free", point: { x: 100, y: 100 } },
    },
  );
  if (typeof branch === "string") throw new Error(branch);
  source = transact(source, [
    {
      kind: "transact_document",
      documentId: document.id,
      expectedRevision: document.revision,
      edits: branch.edits,
    },
  ]);
  const original = source.documents[0]!;
  const selector = original.annotations.find(
    (annotation) =>
      annotation.binding?.kind === "net-name" &&
      annotation.binding.memberEndpoints,
  )!;
  expect(selector).toBeDefined();
  const destination = createEmptyProject("slice-target", "Target");
  const clipboard = captureProjectCopy(source, original)!;
  const copied = applyProjectCopyPlacement(
    planProjectCopyPlacement(
      destination,
      destination.documents[0]!,
      clipboard,
      { x: 0, y: 300 },
      1,
    ),
  );
  const cell = copied.documents[0]!;
  const binding = cell.annotations.find(
    (annotation) =>
      annotation.binding?.kind === "net-name" &&
      annotation.binding.memberEndpoints,
  )!.binding!;
  if (binding.kind !== "net-name") throw new Error("Missing copied selector");
  const originalBinding = selector.binding!;
  if (originalBinding.kind !== "net-name")
    throw new Error("Missing source selector");
  expect(binding.memberEndpoints).toHaveLength(2);
  for (const [index, endpoint] of binding.memberEndpoints!.entries()) {
    expect(endpoint.memberId).not.toBe(
      originalBinding.memberEndpoints![index]!.memberId,
    );
    if (endpoint.kind === "junction")
      expect(
        cell.junctions
          .find((junction) => junction.id === endpoint.junctionId)!
          .members!.some((member) => member.id === endpoint.memberId),
      ).toBe(true);
  }
  expect(cell.connectivityEvidence).toHaveLength(
    original.connectivityEvidence.length,
  );
});

it("copies a same-expression member permutation by its saved connections", () => {
  let source = fixture();
  const before = source.documents[0]!.netlist!.terminals[0]!.signal!.members;
  source = transact(
    source,
    planRenameCellTerminal(
      source,
      source.documents[0]!.id,
      "formal",
      "DATA<3:0>",
      {
        memberMap: { [before[0]!.id]: "DATA<0>", [before[3]!.id]: "DATA<3>" },
      },
    ),
  );
  const clipboard = captureProjectCopy(source, source.documents[0]!)!;
  const destination = createEmptyProject("permutation-target", "Target");
  const copied = applyProjectCopyPlacement(
    planProjectCopyPlacement(
      destination,
      destination.documents[0]!,
      clipboard,
      { x: 0, y: 100 },
      1,
    ),
  );
  const cell = copied.documents[0]!;
  const members = cell.netlist!.terminals[0]!.signal!.members;
  expect(members.map((member) => member.name)).toEqual([
    "DATA<3>",
    "DATA<2>",
    "DATA<1>",
    "DATA<0>",
  ]);
  expect(
    cell.routes
      .find((route) => route.members)!
      .members!.map(
        (lane) =>
          members.find((member) => member.id === lane.startMemberId)?.name,
      ),
  ).toEqual(["DATA<0>", "DATA<2>", "DATA<1>", "DATA<3>"]);
});

it("reuses a Cell's formals while cloning detached stub identities and rejects a stale placement atomically", () => {
  let source = fixture();
  const child = source.documents[0]!;
  const original = child.netlist!.terminals[0]!.signal!.members;
  const parent = createEmptyDocument("parent", "Parent");
  parent.instances.push({
    id: "caller",
    symbolId: hierarchicalSymbolId(child.netlist!.name),
    reference: "X1",
    placement: { position: { x: 200, y: 0 }, rotation: 0, mirror: "none" },
    netlist: {
      binding: { kind: "subcircuit", childDocumentId: child.id },
      parameters: {},
    },
  });
  source = transact(source, [{ kind: "add_document", document: parent }]);
  const wire = proposeWireIntent(
    parent,
    createProjectSymbolResolver(source, builtInSymbols),
    {
      id: "caller-wire",
      from: {
        kind: "endpoint",
        endpoint: {
          kind: "terminal",
          instanceId: "caller",
          pinName: "DATA<3:0>",
        },
      },
      to: { kind: "free", point: { x: 0, y: 0 } },
    },
  );
  if (typeof wire === "string") throw new Error(wire);
  source = transact(source, [
    {
      kind: "transact_document",
      documentId: parent.id,
      expectedRevision: parent.revision,
      edits: wire.edits,
    },
  ]);
  source = transact(
    source,
    planRenameCellTerminal(source, child.id, "formal", "DATA<3,1,0>", {
      memberMap: { [original[1]!.id]: null },
    }),
  );
  const cell = source.documents.find((document) => document.id === parent.id)!;
  const clipboard = captureProjectCopy(source, cell)!;
  const plan = planProjectCopyPlacement(
    source,
    cell,
    clipboard,
    { x: 0, y: 400 },
    1,
  );
  const copied = applyProjectCopyPlacement(plan);
  expect(copied.documents).toHaveLength(2);
  const result = copied.documents.find(
    (document) => document.id === parent.id,
  )!;
  const callerId = plan.instanceIds[0]!;
  expect(
    result.nets
      .flatMap((net) => net.terminals)
      .filter((terminal) => terminal.instanceId === callerId)
      .map((terminal) => terminal.memberId)
      .sort(),
  ).toEqual([original[0]!.id, original[2]!.id, original[3]!.id].sort());
  const oldJunctionMembers = new Set(
    cell.junctions.flatMap(
      (junction) => junction.members?.map((member) => member.id) ?? [],
    ),
  );
  expect(
    result.junctions
      .filter(
        (junction) => !cell.junctions.some((old) => old.id === junction.id),
      )
      .flatMap((junction) => junction.members ?? [])
      .every((member) => !oldJunctionMembers.has(member.id)),
  ).toBe(true);
  const stale = structuredClone(source);
  stale.structureRevision += 1;
  const rejected = executeProjectTransaction(stale, {
    transactionId: "stale-copy",
    projectId: stale.id,
    expectedStructureRevision: source.structureRevision,
    actor: { kind: "human", id: "test" },
    edits: plan.edits,
  });
  expect(rejected.ok).toBe(false);
  expect(rejected.project).toEqual(stale);
});

it("preserves captured caller artwork and remaps its formal members with an imported Cell", () => {
  let source = fixture();
  const child = source.documents[0]!;
  const formal = child.netlist!.terminals[0]!;
  const custom = createBlockSymbol({
    id: "custom-bus",
    name: "Authored artwork",
    terminals: [
      {
        id: formal.id,
        name: formal.name,
        direction: "input",
        signalMembers: formal.signal!.members.map(({ id, name }) => ({
          id,
          name,
        })),
      },
    ],
  });
  const parent = createEmptyDocument("parent", "Parent");
  parent.instances.push({
    id: "caller",
    symbolId: custom.id,
    reference: "X1",
    placement: {
      position: { x: 100, y: 100 },
      rotation: 90,
      mirror: "horizontal",
    },
    netlist: {
      binding: { kind: "subcircuit", childDocumentId: child.id },
      parameters: {},
    },
  });
  source = transact(source, [
    { kind: "capture_component_definition", definition: { symbol: custom } },
    { kind: "add_document", document: parent },
  ]);
  const wire = proposeWireIntent(
    parent,
    createProjectSymbolResolver(source, builtInSymbols),
    {
      id: "custom-tap",
      from: {
        kind: "endpoint",
        endpoint: {
          kind: "terminal",
          instanceId: "caller",
          pinName: formal.name,
          memberId: formal.signal!.members[0]!.id,
        },
      },
      to: { kind: "free", point: { x: 400, y: 400 } },
    },
  );
  if (typeof wire === "string") throw new Error(wire);
  source = transact(source, [
    {
      kind: "transact_document",
      documentId: parent.id,
      expectedRevision: parent.revision,
      edits: wire.edits,
    },
  ]);
  const wired = source.documents.find((cell) => cell.id === parent.id)!;
  source = transact(source, [
    {
      kind: "transact_document",
      documentId: parent.id,
      expectedRevision: wired.revision,
      edits: [
        {
          kind: "add_junction",
          junctionId: "caller-contact",
          netId: wired.routes[0]!.netId,
          position: { x: 0, y: 0 },
          contactAnchor: {
            instanceId: "caller",
            pinName: formal.name,
            memberId: formal.signal!.members[0]!.id,
          },
        },
      ],
    },
  ]);
  const clipboard = captureProjectCopy(
    source,
    source.documents.find((cell) => cell.id === parent.id)!,
  )!;
  const destination = createEmptyProject("artwork-destination", "Destination");
  const copied = applyProjectCopyPlacement(
    planProjectCopyPlacement(
      destination,
      destination.documents[0]!,
      clipboard,
      { x: 0, y: 0 },
      1,
    ),
  );
  const caller = copied.documents[0]!.instances[0]!;
  const symbol = createProjectSymbolResolver(copied, builtInSymbols).resolve(
    caller.symbolId,
  )!.definition;
  expect(symbol.name).toBe("Authored artwork");
  expect(symbol.primitives).toEqual(custom.primitives);
  const binding = caller.netlist!.binding!;
  if (binding.kind !== "subcircuit")
    throw new Error("Missing copied child binding");
  const copiedChild = copied.documents.find(
    (cell) => cell.id === binding.childDocumentId,
  )!;
  expect(symbol.pins[0]!.signalMembers!.map((member) => member.id)).toEqual(
    copiedChild.netlist!.terminals[0]!.signal!.members.map(
      (member) => member.id,
    ),
  );
  expect(symbol.pins[0]!.signalMembers![0]!.id).not.toBe(
    formal.signal!.members[0]!.id,
  );
  expect(
    copied.documents[0]!.junctions.find((item) => item.contactAnchor)!
      .contactAnchor!.memberId,
  ).toBe(copiedChild.netlist!.terminals[0]!.signal!.members[0]!.id);
});
