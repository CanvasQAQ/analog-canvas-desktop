import type { CircuitProject } from "@icm/model";
import { requireDocument, transactDocument } from "./cell-document-edits.js";
import type { ProjectStructureEdit } from "./project-transaction.js";
import { planEnsureNamedRoute } from "./signal-wire-planner.js";
export function planNameSignalRoute(
  project: CircuitProject,
  documentId: string,
  routeId: string,
  expression: string,
  annotationId: string,
): ProjectStructureEdit[] {
  const document = requireDocument(project, documentId);
  const routeToName = document.routes.find((item) => item.id === routeId)!;
  const plan = planEnsureNamedRoute(document, routeId, {
    candidateNetId: routeToName.netId,
    name: expression,
    evidenceId: annotationId + "-claim",
    owner: { kind: "net-label", annotationId },
  });
  if (!plan.ok) throw new Error(plan.message);
  const edits = plan.edits;
  if (!edits.length) return [];
  const route = document.routes.find((item) => item.id === routeId)!;
  const existing = document.annotations.find(
    (item) => item.id === annotationId,
  );
  return [
    transactDocument(project, documentId, [
      ...edits,
      {
        kind: "upsert_schematic_annotation",
        annotation: existing ?? {
          id: annotationId,
          kind: "net-label",
          netId: route.netId,
          binding: { kind: "net-name", netId: route.netId },
          anchor: {
            kind: "route",
            routeId,
            legId: route.legs[0]!.id,
            t: 0.5,
            normalOffset: 10,
            direction: "forward",
            orientation: "horizontal",
            fallbackPosition: { x: 0, y: 0 },
          },
          alignment: "middle",
          rotation: 0,
          locked: false,
        },
      },
    ]),
  ];
}
