import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  createEmptyProject,
  createEmptyDocument,
  createRoutePath,
  type CircuitProject,
  type RouteEndpoint,
} from "@icm/model";
import { hierarchicalSymbolId } from "@icm/symbols";
import {
  analyzeDesignNetlist,
  createDesignNetlistExport,
  generateCircuitSource,
} from "@icm/netlist";
import { parseProject, serializeProject } from "@icm/project-protocol";
import {
  executeProjectTransaction,
  type ProjectStructureEdit,
} from "./project-transaction.js";
import { planCreateCellPin } from "./cell-pin-planner.js";
import type { SchematicEdit } from "./edit-schema.js";

const values = [0.1, 0.2, 0.3, 0.4];
let sequence = 0;
function transact(
  project: CircuitProject,
  edits: readonly ProjectStructureEdit[],
) {
  const result = executeProjectTransaction(project, {
    transactionId: `oracle-${++sequence}`,
    projectId: project.id,
    expectedStructureRevision: project.structureRevision,
    actor: { kind: "human", id: "numeric-acceptance" },
    edits: [...edits],
  });
  if (!result.ok)
    throw new Error(
      JSON.stringify({ error: result.error, diagnostics: result.diagnostics }),
    );
  return result.project;
}
function documentEdit(
  project: CircuitProject,
  documentId: string,
  edits: SchematicEdit[],
) {
  return transact(project, [
    {
      kind: "transact_document",
      documentId,
      expectedRevision: project.documents.find((d) => d.id === documentId)!
        .revision,
      edits,
    },
  ]);
}
function vector(
  project: CircuitProject,
  documentId: string,
  id: string,
  name: string,
  x: number,
) {
  return transact(
    project,
    planCreateCellPin(project, documentId, {
      instance: {
        id,
        symbolId: "port",
        placement: { position: { x, y: 0 }, rotation: 0, mirror: "none" },
      },
      terminal: {
        id: `${id}-terminal`,
        name,
        netId: `${id}-net`,
        direction: "passive",
        interfaceInstanceIds: [id],
      },
      connectionEdits: [],
      signalExpression: name,
    }),
  );
}
const endpoint = (
  instanceId: string,
  pinName: string,
  memberId?: string,
): RouteEndpoint => ({
  kind: "terminal",
  instanceId,
  pinName,
  ...(memberId ? { memberId } : {}),
});
const connect = (
  from: RouteEndpoint,
  to: RouteEndpoint,
  newNetId: string,
): SchematicEdit => ({ kind: "connect_endpoints", from, to, newNetId });
const resistor = (id: string, value: string) => ({
  id,
  reference: id,
  symbolId: "resistor",
  placement: null,
  netlist: {
    binding: { kind: "primitive" as const, deviceClass: "resistor" as const },
    parameters: { value },
  },
});

function busDcFixture() {
  let project = createEmptyProject("bus-dc", "Bus DC oracle", "child");
  project.documents[0]!.netlist!.name = "bus_pass";
  project = vector(project, "child", "in", "IN<3:0>", 0);
  project = vector(project, "child", "out", "OUT<3:0>", 200);
  const child = project.documents[0]!;
  const ins = child.netlist!.terminals[0]!.signal!.members;
  const outs = child.netlist!.terminals[1]!.signal!.members;
  project = documentEdit(
    project,
    child.id,
    ins.flatMap((member, i) => [
      {
        kind: "add_instance",
        instance: resistor(`R${i}`, "1k"),
      } as SchematicEdit,
      connect(
        endpoint("in", "P", member.id),
        endpoint(`R${i}`, "1"),
        `child-in-${i}`,
      ),
      connect(
        endpoint(`R${i}`, "2"),
        endpoint("out", "P", outs[i]!.id),
        `child-out-${i}`,
      ),
    ]),
  );
  const top = createEmptyDocument("top", "bus_testbench");
  top.netlist!.name = "bus_testbench";
  top.instances.push({ id: "gnd", symbolId: "ground", placement: null });
  for (const [i, value] of values.entries())
    top.instances.push({
      id: `V${i}`,
      reference: `V${i}`,
      symbolId: "voltage-source",
      placement: null,
      netlist: {
        binding: { kind: "primitive", deviceClass: "voltage-source" },
        parameters: { dc: String(value) },
      },
    });
  for (const variant of ["identity", "reverse"]) {
    top.instances.push({
      id: variant,
      reference: `X${variant}`,
      symbolId: hierarchicalSymbolId("bus_pass"),
      placement: {
        position: { x: 300, y: variant === "identity" ? -100 : 100 },
        rotation: 0,
        mirror: "none",
      },
      netlist: {
        binding: { kind: "subcircuit", childDocumentId: child.id },
        parameters: {},
      },
    });
    for (let i = 0; i < 4; i++)
      top.instances.push(resistor(`RL_${variant}_${i}`, "1G"));
  }
  project = {
    ...project,
    topDocumentId: top.id,
    documents: [...project.documents, top],
  };
  project = vector(project, top.id, "data", "DATA<7:4>", 0);
  const data = project.documents.find((d) => d.id === top.id)!.netlist!
    .terminals[0]!.signal!.members;
  const edits: SchematicEdit[] = [];
  for (const variant of ["identity", "reverse"]) {
    edits.push({
      kind: "set_route_path",
      route: createRoutePath({
        id: `trunk-${variant}`,
        netId: data[0]!.netId,
        start: endpoint("data", "P"),
        end: endpoint(variant, "IN<3:0>"),
        bends: [],
        modes: ["manual"],
        members: data.map((member, i) => ({
          id: `${variant}-lane-${i}`,
          netId: member.netId,
          startMemberId: member.id,
          endMemberId: ins[variant === "identity" ? i : 3 - i]!.id,
        })),
      }),
    });
    for (let i = 0; i < 4; i++)
      edits.push(
        connect(
          endpoint(variant, "OUT<3:0>", outs[i]!.id),
          endpoint(`RL_${variant}_${i}`, "1"),
          `${variant}-output-${i}`,
        ),
        connect(
          endpoint(`RL_${variant}_${i}`, "2"),
          endpoint("gnd", "0"),
          "ground",
        ),
      );
  }
  for (let i = 0; i < 4; i++)
    edits.push(
      connect(
        endpoint(`V${i}`, "+"),
        endpoint("data", "P", data[i]!.id),
        `source-${i}`,
      ),
      connect(endpoint(`V${i}`, "-"), endpoint("gnd", "0"), "ground"),
    );
  project = documentEdit(project, top.id, edits);
  const saved = serializeProject(project);
  project = parseProject(saved);
  expect(serializeProject(project)).toBe(saved);
  for (const format of ["spice", "spectre"] as const) {
    const exported = createDesignNetlistExport(project, {
      format,
      includeIr: true,
    });
    expect(exported.status, JSON.stringify(exported.diagnostics)).toBe("ready");
    if (exported.status !== "ready") throw new Error("Export refused");
    expect(
      exported.ir!.cells.find((c) => c.id === child.id)!.ports,
    ).toHaveLength(8);
  }
  const analysis = analyzeDesignNetlist(project);
  expect(analysis.ir, JSON.stringify(analysis.diagnostics)).not.toBeNull();
  const childIR = analysis.ir!.cells.find((c) => c.id === child.id)!;
  expect(childIR.ports.map((p) => p.name)).toEqual([
    "IN_3_",
    "IN_2_",
    "IN_1_",
    "IN_0_",
    "OUT_3_",
    "OUT_2_",
    "OUT_1_",
    "OUT_0_",
  ]);
  const topIR = analysis.ir!.cells.find((c) => c.id === top.id)!;
  const measured: {
    node: string;
    expected: number;
    variant: string;
    member: number;
  }[] = [];
  for (const variant of ["identity", "reverse"]) {
    const call = topIR.instances.find((instance) => instance.id === variant)!;
    expect(call.nodes.map((n) => n.pinName)).toEqual([
      "IN<3>",
      "IN<2>",
      "IN<1>",
      "IN<0>",
      "OUT<3>",
      "OUT<2>",
      "OUT<1>",
      "OUT<0>",
    ]);
    expect(new Set(call.nodes.map((n) => n.netName)).size).toBe(8);
    for (let i = 0; i < 4; i++)
      measured.push({
        node: call.nodes[i + 4]!.netName,
        expected:
          (values[variant === "identity" ? i : 3 - i]! * 1e9) / (1e9 + 1e3),
        variant,
        member: 3 - i,
      });
  }
  const source = generateCircuitSource(
    project,
    {
      id: "oracle",
      path: "circuit.spice",
      documentId: top.id,
      emission: "top-level",
    },
    undefined,
    "ngspice",
  );
  if (!source.ok) throw new Error(JSON.stringify(source.diagnostics));
  const deck = `${source.source.text}\n.control\nop\n${measured.map((m) => `print v(${m.node})`).join("\n")}\nquit\n.endc\n.end\n`;
  return { deck, measured, project };
}

it("exports distinct bus members through identity and reverse hierarchy after canonical reopening", () => {
  const { project, deck, measured } = busDcFixture();
  expect(measured).toHaveLength(8);
  expect(deck).toContain(".subckt bus_pass");
  expect(
    project.documents
      .find((cell) => cell.id === "child")!
      .netlist!.terminals.map((terminal) => terminal.name),
  ).toEqual(["IN<3:0>", "OUT<3:0>"]);
});

// Native ngspice is optional in unit-test hosts. Local Windows acceptance may
// explicitly select a WSL distribution; no alternate simulator is substituted.
const distro = process.env.ICM_BUS_NGSPICE_WSL_DISTRO;
const executable = distro ? "wsl" : "ngspice";
const prefix = distro ? ["-d", distro, "--", "ngspice"] : [];
const available =
  spawnSync(executable, [...prefix, "--version"], { encoding: "utf8" })
    .status === 0;
it.skipIf(!available)(
  "ngspice proves four independent DC values and whole-bus reversal",
  () => {
    const { deck, measured } = busDcFixture();
    const directory = mkdtempSync(join(tmpdir(), "icm-bus-dc-"));
    try {
      const path = join(directory, "bus.cir");
      writeFileSync(path, deck);
      const simulatorPath = distro
        ? path
            .replace(
              /^([A-Za-z]):/u,
              (_, letter: string) => `/mnt/${letter.toLowerCase()}`,
            )
            .replaceAll("\\", "/")
        : path;
      const output = execFileSync(
        executable,
        [...prefix, "-b", simulatorPath],
        { encoding: "utf8", timeout: 30000 },
      );
      for (const measurement of measured) {
        const row = output
          .split(/\r?\n/u)
          .find((line) =>
            line
              .toLowerCase()
              .startsWith(`v(${measurement.node.toLowerCase()}) =`),
          );
        expect(
          row,
          `${measurement.variant} OUT<${measurement.member}>`,
        ).toBeDefined();
        const actual = Number(row!.split("=")[1]!.trim());
        expect(
          Math.abs(actual - measurement.expected),
          JSON.stringify({ ...measurement, actual }),
        ).toBeLessThan(1e-6);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
