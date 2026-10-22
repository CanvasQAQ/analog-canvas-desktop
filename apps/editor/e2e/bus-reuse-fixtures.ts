import {
  createEmptyDocument,
  createEmptyProject,
  createRoutePath,
  labelTextDocument,
  type CircuitProject,
} from "@icm/model";
import {
  executeProjectTransaction,
  planEnsureNamedRoute,
  planSetCellTerminalSignal,
  proposeWireIntent,
  type ProjectStructureEdit,
  type SchematicEdit,
} from "@icm/edit-engine";
import {
  builtInSymbols,
  createProjectSymbolResolver,
  hierarchicalSymbolId,
} from "@icm/symbols";

/** Converted scalar contacts deliberately reach one bit; other bits stay open. */
export function busReuseProject(): CircuitProject {
  let project = createEmptyProject(
    "bus-reuse-source",
    "Bus reuse source",
    "top",
  );
  const child = createEmptyDocument("child", "Bus child");
  child.netlist!.name = "bus_child";
  child.instances.push(
    {
      id: "P1",
      symbolId: "port",
      placement: { position: { x: 100, y: 200 }, rotation: 0, mirror: "none" },
    },
    {
      id: "R1",
      symbolId: "resistor",
      reference: "R1",
      placement: { position: { x: 250, y: 200 }, rotation: 0, mirror: "none" },
      netlist: { parameters: { value: "1k" } },
    },
  );
  child.nets.push({
    id: "inside",
    terminals: [
      { instanceId: "P1", pinName: "P" },
      { instanceId: "R1", pinName: "1" },
    ],
  });
  child.netlist!.terminals.push({
    id: "formal",
    name: "IN[1:0]",
    netId: "inside",
    direction: "input",
    interfaceInstanceIds: ["P1"],
  });
  child.annotations.push({
    id: "pin-label",
    kind: "instance-label",
    binding: { kind: "cell-terminal-name", terminalId: "formal" },
    anchor: {
      kind: "object",
      objectId: "P1",
      localOffset: { x: 0, y: -20 },
      fallbackPosition: { x: 100, y: 180 },
    },
    alignment: "middle",
    rotation: 0,
    locked: false,
  });
  project.documents.push(child);
  const top = project.documents[0]!;
  for (const [index, id] of ["X1", "X2"].entries()) {
    top.instances.push({
      id,
      reference: id,
      symbolId: hierarchicalSymbolId("bus_child"),
      placement: {
        position: { x: 400 + index * 250, y: 200 + index * 200 },
        rotation: index ? 270 : 90,
        mirror: index ? "vertical" : "horizontal",
      },
      netlist: {
        binding: { kind: "subcircuit", childDocumentId: child.id },
        parameters: {},
      },
    });
    const netId = `outside-${index}`;
    top.nets.push({
      id: netId,
      terminals: [{ instanceId: id, pinName: "IN[1:0]" }],
    });
    top.junctions.push({
      id: `anchor-${index}`,
      netId,
      position: { x: 100, y: 200 + index * 200 },
    });
    top.routes.push(
      createRoutePath({
        id: `wire-${index}`,
        netId,
        start: { kind: "junction", junctionId: `anchor-${index}` },
        end: { kind: "terminal", instanceId: id, pinName: "IN[1:0]" },
        bends: [{ x: 250, y: 200 + index * 200 }],
        modes: ["manual", "manual"],
      }),
    );
  }
  top.annotations.push({
    id: "label",
    kind: "net-label",
    netId: "outside-0",
    binding: { kind: "net-name", netId: "outside-0" },
    anchor: {
      kind: "route",
      routeId: "wire-0",
      legId: top.routes[0]!.legs[0]!.id,
      t: 0.5,
      normalOffset: -20,
      direction: "forward",
      orientation: "horizontal",
      fallbackPosition: { x: 175, y: 180 },
    },
    alignment: "middle",
    rotation: 0,
    locked: false,
    sizeScale: 1.25,
  });
  top.connectivityEvidence.push({
    id: "claim",
    kind: "name-claim",
    netId: "outside-0",
    name: "DATA[1:0]",
    scope: "local",
    owner: { kind: "net-label", annotationId: "label" },
  });
  let sequence = 0;
  const commit = (edits: ProjectStructureEdit[]) => {
    const result = executeProjectTransaction(project, {
      transactionId: `reuse-fixture-${++sequence}`,
      projectId: project.id,
      expectedStructureRevision: project.structureRevision,
      actor: { kind: "human", id: "reuse-fixture" },
      edits,
    });
    if (!result.ok)
      throw new Error(
        JSON.stringify({
          error: result.error,
          diagnostics: result.diagnostics,
        }),
      );
    project = result.project;
  };
  const editTop = (edits: readonly SchematicEdit[]) =>
    commit([
      {
        kind: "transact_document",
        documentId: "top",
        expectedRevision: project.documents[0]!.revision,
        edits: [...edits],
      },
    ]);
  commit(
    planSetCellTerminalSignal(project, "child", "formal", "IN<1:0>", {
      convertLegacy: true,
      memberMap: { formal: "IN<1>" },
    }),
  );
  const named = planEnsureNamedRoute(
    project.documents[0]!,
    "wire-0",
    {
      candidateNetId: "outside-0",
      name: "DATA<1:0>",
      evidenceId: "claim",
      owner: { kind: "net-label", annotationId: "label" },
    },
    { convertLegacy: true, memberMap: { claim: "DATA<1>" } },
    createProjectSymbolResolver(project, builtInSymbols),
  );
  if (!named.ok) throw new Error(named.message);
  editTop(named.edits);
  const wire = project.documents[0]!.routes.find(
    (route) => route.id === "wire-0",
  )!;
  const tap = proposeWireIntent(
    project.documents[0]!,
    createProjectSymbolResolver(project, builtInSymbols),
    {
      id: "tap",
      from: {
        kind: "endpoint",
        endpoint: wire.start,
        selectionExpression: "<0>",
      },
      to: { kind: "free", point: { x: 100, y: 320 } },
    },
  );
  if (typeof tap === "string") throw new Error(tap);
  editTop(tap.edits);
  const label = project.documents[0]!.annotations.find(
    (annotation) => annotation.id === "label",
  )!;
  const format = labelTextDocument(
    "DATA<1:0>",
    project.documents[0]!.presentation,
  );
  editTop([
    {
      kind: "upsert_schematic_annotation",
      annotation: {
        ...label,
        formatOverride: {
          ...format,
          runs: [{ kind: "span", style: "bold", children: format.runs }],
        },
      },
    },
  ]);
  return project;
}
