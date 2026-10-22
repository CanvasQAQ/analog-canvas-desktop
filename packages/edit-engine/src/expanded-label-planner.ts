import {
  deriveStableId,
  parseSignalExpression,
  renamedLabelFormat,
  roleLabelFormat,
  type SchematicDocument,
} from "@icm/model";
import {
  isNearVerticalSegment,
  NET_LABEL_WIRE_GAP,
  netLabelBaselineForName,
  resolveAnnotationName,
  netLabelStandardOffset,
  resolveRouteGeometry,
} from "@icm/derived";
import type { SymbolResolver } from "@icm/symbols";
import type { SchematicEdit } from "./edit-schema.js";
import {
  planEnsureNamedRoute,
  resolveNetLabelOwnerRoute,
} from "./signal-wire-planner.js";

/** Explicit branch order pairs with expression order; the Project publishes all Labels atomically. */
export function planExpandedNetLabels(
  document: SchematicDocument,
  resolver: SymbolResolver,
  expression: string,
  routeIds: readonly string[],
): SchematicEdit[] {
  const names = parseSignalExpression(expression);
  if (
    names.length !== routeIds.length ||
    new Set(routeIds).size !== routeIds.length
  )
    throw new Error(
      `Choose ${names.length} distinct scalar branches in Label order`,
    );
  const nets = new Set<string>();
  return routeIds.flatMap((routeId, index): SchematicEdit[] => {
    const route = document.routes.find((item) => item.id === routeId);
    if (!route || route.members)
      throw new Error(`Choose an existing scalar branch: ${routeId}`);
    if (nets.has(route.netId))
      throw new Error("Each expanded Label needs a distinct scalar Net");
    nets.add(route.netId);
    const existing = document.annotations.find(
      (annotation) =>
        annotation.kind === "net-label" &&
        resolveNetLabelOwnerRoute(document, annotation)?.id === route.id,
    );
    if (existing?.locked) throw new Error(`Label is locked: ${existing.id}`);
    const annotationId = existing?.id ?? `net-label-${routeId}`;
    const name = names[index]!;
    const claim = document.connectivityEvidence.find(
      (item) =>
        item.kind === "name-claim" &&
        item.owner.kind === "net-label" &&
        item.owner.annotationId === annotationId,
    );
    const naming = planEnsureNamedRoute(
      document,
      routeId,
      {
        candidateNetId: route.netId,
        name,
        evidenceId:
          claim?.id ?? deriveStableId("signal-name", document.id, annotationId),
        owner: { kind: "net-label", annotationId },
      },
      {},
      resolver,
    );
    if (!naming.ok) throw new Error(naming.message);
    const geometry = resolveRouteGeometry(document, resolver, route);
    const segment = geometry?.segments[0];
    if (!segment) throw new Error(`Branch has no visible geometry: ${routeId}`);
    const formatOverride = existing
      ? renamedLabelFormat(
          existing,
          resolveAnnotationName(document, existing),
          name,
          document.presentation,
        )
      : roleLabelFormat("voltage-node", name);
    const vertical = isNearVerticalSegment(segment.from, segment.to);
    const baseline = netLabelBaselineForName(
      name,
      formatOverride,
      document.presentation,
      existing?.sizeScale ?? 1,
    );
    return [
      ...naming.edits,
      {
        kind: "upsert_schematic_annotation",
        annotation: {
          ...(existing ?? {
            id: annotationId,
            kind: "net-label" as const,
            alignment: vertical ? ("start" as const) : ("middle" as const),
            rotation: 0 as const,
            locked: false,
          }),
          formatOverride,
          netId: naming.netId,
          binding:
            existing?.binding?.kind === "net-name" &&
            existing.binding.memberEndpoint
              ? existing.binding
              : { kind: "net-name", netId: naming.netId },
          anchor: existing?.anchor ?? {
            kind: "route",
            routeId,
            legId: segment.address.legId,
            t: 0.5,
            normalOffset: netLabelStandardOffset(
              segment.from,
              segment.to,
              baseline,
            ),
            direction: "forward",
            orientation: "follow",
            fallbackPosition: {
              x:
                (segment.from.x + segment.to.x) / 2 +
                (vertical ? NET_LABEL_WIRE_GAP : 0),
              y:
                (segment.from.y + segment.to.y) / 2 - (vertical ? 0 : baseline),
            },
          },
        },
      },
    ];
  });
}
