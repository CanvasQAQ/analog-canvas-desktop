import { createEmptyDocument, createRoutePath } from "@icm/model";
import { InMemorySymbolResolver } from "@icm/symbols";
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
