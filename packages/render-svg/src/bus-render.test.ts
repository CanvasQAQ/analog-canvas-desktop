import { createEmptyDocument, createRoutePath } from "@icm/model";
import {
  builtInSymbols,
  createBlockSymbol,
  InMemorySymbolResolver,
} from "@icm/symbols";
import { expect, it } from "vitest";
import { buildSvgScene, renderDocumentSvg } from "./render.js";

const resolver = new InMemorySymbolResolver([]);

function busDrawing() {
  const document = createEmptyDocument("bus-drawing", "Bus drawing");
  const members = Array.from({ length: 4 }, (_, index) => ({
    id: `bit-${index}`,
    netId: `net-${index}`,
  }));
  document.nets.push(
    ...members.map(({ netId }) => ({ id: netId, terminals: [] })),
  );
  document.junctions.push(
    ...[
      ["left", 0],
      ["tap", 100],
      ["right", 200],
    ].map(([id, x]) => ({
      id: String(id),
      netId: "net-0",
      position: { x: Number(x), y: 0 },
      members,
    })),
    { id: "branch-end", netId: "net-1", position: { x: 100, y: 100 } },
  );
  document.routes.push(
    ...[
      ["west", "left", "tap"],
      ["east", "tap", "right"],
    ].map(([id, from, to]) =>
      createRoutePath({
        id: id!,
        netId: "net-0",
        start: { kind: "junction", junctionId: from! },
        end: { kind: "junction", junctionId: to! },
        bends: [],
        modes: ["manual"],
        members: members.map((member) => ({
          ...member,
          id: `${id}-${member.id}`,
          startMemberId: member.id,
          endMemberId: member.id,
        })),
      }),
    ),
    createRoutePath({
      id: "branch",
      netId: "net-1",
      start: { kind: "junction", junctionId: "tap", memberId: "bit-1" },
      end: { kind: "junction", junctionId: "branch-end" },
      bends: [],
      modes: ["manual"],
    }),
  );
  return document;
}

function inkWidth(svg: string, path: string) {
  const element = [...svg.matchAll(/<path data-role="conductor-ink"[^>]*\/>/gu)]
    .map(([element]) => element)
    .find((element) => element.includes(path));
  expect(element).toBeDefined();
  return Number(element!.match(/stroke-width="([^"]+)"/u)![1]);
}

it("renders a modest bus stroke and a member tap without a bus-wide junction dot", () => {
  const document = busDrawing();
  const before = structuredClone(document);
  const scene = buildSvgScene(document, resolver);
  expect(inkWidth(scene.formalBody, "M 0 0 L 100 0")).toBeCloseTo(2.4);
  expect(inkWidth(scene.formalBody, "M 100 0 L 100 100")).toBeCloseTo(1.6);
  expect(scene.formalBody).toContain('data-role="bus-tap"');
  expect(scene.formalBody).toContain('data-member-id="bit-1"');
  const junctionLayer = scene.formalBody.match(
    /<g data-layer="junctions">(.*?)<\/g>/su,
  )![1];
  expect(junctionLayer).not.toContain("<circle");
  const svg = renderDocumentSvg(document, resolver);
  expect(svg).toContain(scene.formalBody);
  expect(svg).not.toMatch(
    /editor-overlay|hit-target|width-badge|data-layer="selection"/u,
  );
  expect(document).toEqual(before);
});

it("keeps a member mark inside a cropped export when a scalar is thicker than its bus", () => {
  const document = busDrawing();
  for (const route of document.routes)
    route.documentStyle = {
      wireStrokeScale: route.members ? 0.5 : 2,
    };
  const full = buildSvgScene(document, resolver);
  expect(inkWidth(full.formalBody, "M 0 0 L 100 0")).toBeCloseTo(1.2);
  expect(inkWidth(full.formalBody, "M 100 0 L 100 100")).toBeCloseTo(3.2);
  const cropped = buildSvgScene(document, resolver, {
    objectIds: new Set(["branch"]),
    margin: 0,
  });
  expect(cropped.viewBox.x).toBeLessThan(97);
  expect(cropped.viewBox.x + cropped.viewBox.width).toBeGreaterThan(103);
  expect(cropped.formalBody).toContain('data-role="bus-tap"');
  expect(cropped.formalBody).not.toContain('data-object-id="west"');
});

it.each([{ indices: [3, 1] }, { indices: [3, 2, 1, 0] }])(
  "marks an ordered bus takeoff $indices without relying on a selector Label",
  ({ indices }) => {
    const document = busDrawing();
    const members = indices.map(
      (index) => document.junctions[1]!.members![index]!,
    );
    document.junctions[3]!.members = members;
    document.junctions[3]!.netId = members[0]!.netId;
    document.routes[2] = createRoutePath({
      id: "branch",
      netId: members[0]!.netId,
      start: { kind: "junction", junctionId: "tap" },
      end: { kind: "junction", junctionId: "branch-end" },
      bends: [],
      modes: ["manual"],
      members: members.map((member) => ({
        ...member,
        id: `branch-${member.id}`,
        startMemberId: member.id,
        endMemberId: member.id,
      })),
    });
    expect(document.annotations).toHaveLength(0);
    const scene = buildSvgScene(document, resolver);
    expect(scene.formalBody.match(/data-role="bus-tap"/gu)).toHaveLength(1);
    expect(scene.formalBody).toContain('data-route-id="branch"');
    const cropped = buildSvgScene(document, resolver, {
      objectIds: new Set(["branch"]),
      margin: 0,
    });
    expect(cropped.formalBody).toContain('data-role="bus-tap"');
    expect(cropped.viewBox.x).toBeCloseTo(95.8);
    expect(cropped.viewBox.x + cropped.viewBox.width).toBeCloseTo(104.2);
    expect(
      renderDocumentSvg(document, resolver, {
        objectIds: new Set(["branch"]),
        margin: 0,
      }),
    ).toContain(cropped.formalBody);
  },
);

it("leaves an identity whole-bus continuation unmarked", () => {
  const document = busDrawing();
  document.routes.pop();
  const scene = buildSvgScene(document, resolver);
  expect(scene.formalBody).not.toContain('data-role="bus-tap"');
});

it.each(["Cell Pin", "hierarchical pin"])(
  "marks a slice landing on a %s from its ordered declaration",
  (kind) => {
    const document = busDrawing();
    const members = document.junctions[1]!.members!;
    const terminal = {
      id: "formal",
      name: "DATA<3:0>",
      netId: "net-0",
      direction: "input" as const,
      interfaceInstanceIds: ["P1"],
      signal: {
        expression: "DATA<3:0>",
        members: members.map((member, index) => ({
          ...member,
          name: `DATA<${3 - index}>`,
        })),
      },
    };
    const block = createBlockSymbol({
      id: "child",
      name: "Child",
      terminals: [
        {
          ...terminal,
          signalMembers: terminal.signal.members.map(({ id, name }) => ({
            id,
            name,
          })),
        },
      ],
    });
    const sourceResolver = new InMemorySymbolResolver([
      ...builtInSymbols,
      block,
    ]);
    document.instances.push({
      id: "P1",
      symbolId: kind === "Cell Pin" ? "port" : "child",
      placement: { position: { x: 100, y: 0 }, rotation: 0, mirror: "none" },
    });
    if (kind === "Cell Pin") document.netlist!.terminals.push(terminal);
    const pinName = kind === "Cell Pin" ? "P" : "DATA<3:0>";
    for (const [index, member] of members.entries())
      document.nets[index]!.terminals.push({
        instanceId: "P1",
        pinName,
        memberId: member.id,
      });
    const selected = [members[3]!, members[1]!];
    document.junctions[3]!.members = selected;
    document.junctions[3]!.netId = selected[0]!.netId;
    document.routes[2] = createRoutePath({
      id: "branch",
      netId: selected[0]!.netId,
      start: { kind: "junction", junctionId: "branch-end" },
      end: { kind: "terminal", instanceId: "P1", pinName },
      bends: [],
      modes: ["manual"],
      members: selected.map((member) => ({
        ...member,
        id: `branch-${member.id}`,
        startMemberId: member.id,
        endMemberId: member.id,
      })),
    });
    const scene = buildSvgScene(document, sourceResolver);
    expect(scene.formalBody.match(/data-role="bus-tap"/gu)).toHaveLength(1);
    expect(scene.formalBody).toContain('data-member-ids="bit-3 bit-1"');
  },
);
