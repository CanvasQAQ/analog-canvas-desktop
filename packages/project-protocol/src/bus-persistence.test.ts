import { expect, it } from "vitest";
import { createEmptyProject, createRoutePath, routeEnd } from "@icm/model";
import { parseProject, serializeProject } from "./index.js";

function busProject(reversed = false, bent = false) {
  const project = createEmptyProject("bus-codec", "Bus codec");
  const document = project.documents[0]!;
  const members = [3, 2, 1, 0].map((index) => ({
    id: `bit-${index}`,
    name: `DATA<${index}>`,
    netId: `net-${index}`,
  }));
  document.instances.push({
    id: "port",
    symbolId: "port",
    placement: { position: { x: 0, y: 0 }, rotation: 0, mirror: "none" },
  });
  document.netlist!.terminals.push({
    id: "data",
    name: "DATA<3:0>",
    netId: "net-3",
    direction: "input",
    interfaceInstanceIds: ["port"],
    signal: { expression: "DATA<3:0>", members },
  });
  document.nets.push(
    ...members.map((member) => ({
      id: member.netId,
      terminals: [{ instanceId: "port", pinName: "P", memberId: member.id }],
    })),
  );
  document.junctions.push(
    {
      id: "bus-end",
      netId: "net-3",
      position: { x: 100, y: 0 },
      role: "route-anchor",
      members: members.map(({ id, netId }) => ({ id, netId })),
    },
    {
      id: "tap-end",
      netId: "net-2",
      position: { x: 100, y: 100 },
      role: "route-anchor",
    },
  );
  document.routes.push(
    createRoutePath({
      id: "bus",
      netId: "net-3",
      start: { kind: "terminal", instanceId: "port", pinName: "P" },
      end: { kind: "junction", junctionId: "bus-end" },
      bends: [],
      modes: ["manual"],
      members: members.map((member) => ({
        id: `lane-${member.id}`,
        netId: member.netId,
        startMemberId: member.id,
        endMemberId: member.id,
      })),
    }),
  );
  const selected = {
    kind: "junction" as const,
    junctionId: "bus-end",
    memberId: "bit-2",
  };
  const free = { kind: "junction" as const, junctionId: "tap-end" };
  document.routes.push(
    createRoutePath({
      id: "tap",
      netId: "net-2",
      start: reversed ? free : selected,
      end: reversed ? selected : free,
      bends: bent
        ? [
            { x: 150, y: 0 },
            { x: 150, y: 100 },
          ]
        : [],
      modes: bent ? ["manual", "manual", "manual"] : ["manual"],
    }),
  );
  return project;
}

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "round-trips a scalar member tap with reversed=%s bent=%s",
  (reversed, bent) => {
    const saved = serializeProject(busProject(reversed, bent));
    const reopened = parseProject(saved);
    const document = reopened.documents[0]!;
    const tap = document.routes.find((route) => route.id === "tap")!;
    expect(reversed ? routeEnd(tap) : tap.start).toEqual({
      kind: "junction",
      junctionId: "bus-end",
      memberId: "bit-2",
    });
    expect(tap.netId).toBe("net-2");
    expect(document.nets).toHaveLength(4);
    expect(document.routes[0]!.members!.map((member) => member.netId)).toEqual([
      "net-3",
      "net-2",
      "net-1",
      "net-0",
    ]);
    expect(serializeProject(reopened)).toBe(saved);
  },
);

it.each(["expression", "width", "order", "identity"])(
  "refuses a signal with inconsistent %s at the file boundary",
  (problem) => {
    const source = JSON.parse(serializeProject(busProject()));
    const signal = source.documents[0].netlist.terminals[0].signal;
    if (problem === "expression") signal.expression = "DATA<3:>";
    if (problem === "width") signal.members.pop();
    if (problem === "order") signal.members[0].name = "DATA<0>";
    if (problem === "identity") signal.members[1].id = signal.members[0].id;
    expect(() => parseProject(JSON.stringify(source))).toThrow(/Signal/u);
  },
);

it("requires a new file envelope for explicit member connectivity", () => {
  const source = JSON.parse(serializeProject(busProject()));
  expect(source.schemaVersion).toBe(75);
  source.schemaVersion = 74;
  expect(() => parseProject(JSON.stringify(source))).toThrow(
    /Signal members require Project schema 75/u,
  );
});

it("keeps old bracketed Cell Pin and Net Label names scalar", () => {
  const project = createEmptyProject("literal", "Literal names");
  const document = project.documents[0]!;
  document.instances.push({ id: "port", symbolId: "port", placement: null });
  document.nets.push({
    id: "literal-net",
    terminals: [{ instanceId: "port", pinName: "P" }],
  });
  document.netlist!.terminals.push({
    id: "literal-port",
    name: "DATA<3:0>",
    netId: "literal-net",
    direction: "input",
    interfaceInstanceIds: ["port"],
  });
  document.annotations.push({
    id: "label",
    kind: "net-label",
    netId: "literal-net",
    binding: { kind: "net-name", netId: "literal-net" },
    anchor: { kind: "free", position: { x: 0, y: 0 } },
    alignment: "start",
    rotation: 0,
    locked: false,
  });
  document.connectivityEvidence.push({
    id: "claim",
    kind: "name-claim",
    netId: "literal-net",
    name: "DATA<3:0>",
    scope: "local",
    owner: { kind: "net-label", annotationId: "label" },
  });
  const source = JSON.parse(serializeProject(project));
  source.schemaVersion = 74;
  const reopened = parseProject(JSON.stringify(source)).documents[0]!;
  expect(reopened.nets).toHaveLength(1);
  expect(reopened.netlist!.terminals[0]!.signal).toBeUndefined();
  expect(reopened.netlist!.terminals[0]!.name).toBe("DATA<3:0>");
  expect(reopened.connectivityEvidence[0]).toMatchObject({ name: "DATA<3:0>" });
  expect(reopened.connectivityEvidence[0]).not.toHaveProperty("signal");
});

it.each([
  "route endpoint",
  "contact endpoint",
  "symbol pin",
  "selector binding",
])("rejects isolated new metadata in an old envelope: %s", (location) => {
  const source = JSON.parse(serializeProject(createEmptyProject("old", "Old")));
  source.schemaVersion = 74;
  const document = source.documents[0];
  if (location === "route endpoint")
    document.routes = [{ start: { memberId: "bit" } }];
  if (location === "contact endpoint")
    document.connections = {
      contacts: [[{ memberId: "bit" }, { junctionId: "other" }]],
    };
  if (location === "symbol pin")
    source.componentDefinitions = [
      { symbol: { pins: [{ signalMembers: [] }] } },
    ];
  if (location === "selector binding")
    document.annotations = [
      {
        binding: {
          kind: "net-name",
          netId: "net",
          memberEndpoint: {
            kind: "junction",
            junctionId: "junction",
            memberId: "bit",
          },
        },
      },
    ];
  expect(() => parseProject(JSON.stringify(source))).toThrow(
    /Signal members require Project schema 75/u,
  );
});
