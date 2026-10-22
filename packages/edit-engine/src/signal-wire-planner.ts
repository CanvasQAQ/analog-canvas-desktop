import {
  deriveStableId,
  foldNetName,
  flattenRichText,
  parseSignalExpression,
  routeEndpoints,
  type SchematicDocument,
  type RichTextDocument,
  type Point,
  type Annotation,
} from "@icm/model";
import { isFreeWireAnchor, type WireSource } from "./wire-commit-planner.js";
import {
  createRoutingOperationPlan,
  evaluateRoutingOperationPlan,
} from "./routing-operation-plan.js";
import type { EditExecutionContext } from "./transaction-result.js";
import type { SchematicEdit } from "./edit-schema.js";
import {
  applyLabelSignalMigration,
  planLabelSignalMigration,
} from "./label-signal-migration.js";
import type { SignalMigrationOptions } from "./signal-member-migration.js";
import type { SymbolResolver } from "@icm/symbols";
export { previewLabelSignalMigration } from "./label-signal-migration.js";
import {
  planEnsureNamedNet,
  type EnsureNamedNetPlan,
} from "./named-net-planner.js";
import {
  resolveAnnotationText,
  resolveRouteGeometry,
  resolveRouteAttachment,
  netLabelStandardOffset,
  netLabelBaselineForName,
} from "@icm/derived";

/** A free Label owns a member set, which may share a first lane with other wires. */
export function resolveNetLabelOwnerRoute(
  document: SchematicDocument,
  annotation: Annotation,
) {
  const claim = document.connectivityEvidence.find(
    (item) =>
      item.kind === "name-claim" &&
      item.owner.kind === "net-label" &&
      item.owner.annotationId === annotation.id,
  );
  const members =
    claim?.kind === "name-claim" ? claim.signal?.members : undefined;
  if (!claim)
    return document.routes.find((route) =>
      annotation.anchor.kind === "route"
        ? route.id === annotation.anchor.routeId
        : route.netId ===
          (annotation.binding?.kind === "net-name"
            ? annotation.binding.netId
            : annotation.netId),
    );
  return document.routes.find((route) => {
    if (
      annotation.anchor.kind === "route" &&
      route.id !== annotation.anchor.routeId
    )
      return false;
    if (members && members.length > 1)
      return (
        route.members?.length === members.length &&
        members.every((member) =>
          route.members?.some(
            (lane) => lane.id === member.id && lane.netId === member.netId,
          ),
        )
      );
    return (
      !route.members &&
      route.netId ===
        (claim?.kind === "name-claim" ? claim.netId : annotation.netId)
    );
  });
}

/** Naming is transient until the whole Wire gesture commits. */
export function prepareNamedWireSource(
  source: WireSource,
  expression: string,
): WireSource {
  const names = parseSignalExpression(expression);
  if (!isFreeWireAnchor(source)) {
    if (names.length !== (source.members?.length ?? 1))
      throw new Error(
        "Label expression width must match the fixed source; a scalar source cannot be widened",
      );
    return source;
  }
  const endpoint = source.endpoint;
  if (endpoint.kind !== "junction") return source;
  const members = names.map((name, index) => ({
    id: deriveStableId("signal-member", endpoint.junctionId, String(index)),
    netId:
      index === 0 && source.netId
        ? source.netId
        : deriveStableId("signal-net", endpoint.junctionId, String(index)),
    name,
  }));
  const {
    members: _previous,
    declaredScalarName: _previousName,
    ...scalar
  } = source;
  return {
    ...scalar,
    netId: members[0]!.netId,
    ...(names.length > 1 ? { members } : { declaredScalarName: names[0]! }),
    preludeEdits: source.preludeEdits.map((edit) => {
      if (
        edit.kind !== "add_junction" ||
        edit.junctionId !== endpoint.junctionId
      )
        return edit;
      const { members: _old, ...anchor } = edit;
      return {
        ...anchor,
        netId: members[0]!.netId,
        createNet: true,
        ...(names.length > 1
          ? { members: members.map(({ id, netId }) => ({ id, netId })) }
          : {}),
      };
    }),
  };
}

/** Plan the Label against the completed geometry, then publish both in one transaction. */
export function planNamedWireEdits(
  document: SchematicDocument,
  edits: readonly SchematicEdit[],
  routeId: string,
  label: {
    name: string;
    content: RichTextDocument;
    sizeScale: number;
    alignment: "start" | "middle" | "end";
    position: Point;
  },
  context: EditExecutionContext,
): SchematicEdit[] {
  const path = edits.find(
    (edit) => edit.kind === "set_route_path" && edit.route.id === routeId,
  );
  if (path?.kind !== "set_route_path")
    throw new Error("A named Wire needs a visible route");
  const annotationId = `net-label-${routeId}`;
  const pending: SchematicEdit = {
    kind: "upsert_schematic_annotation",
    annotation: {
      id: annotationId,
      kind: "net-label",
      netId: path.route.netId,
      binding: { kind: "net-name", netId: path.route.netId },
      anchor: {
        kind: "route",
        routeId,
        legId: path.route.legs[0]!.id,
        t: 0.5,
        normalOffset: 10,
        direction: "forward",
        orientation: "horizontal",
        fallbackPosition: label.position,
      },
      alignment: label.alignment,
      rotation: 0,
      locked: false,
      sizeScale: label.sizeScale,
    },
  };
  const authored = [...edits, pending];
  const evaluation = evaluateRoutingOperationPlan(
    document,
    createRoutingOperationPlan(document, {
      intent: "connect",
      edits: authored,
      diagnostics: [],
    }),
    context,
  );
  if (!evaluation.ok) throw new Error(evaluation.message);
  const candidate = evaluation.value.finalDocument;
  const annotation = candidate.annotations.find(
    (item) => item.id === annotationId,
  )!;
  const finalRouteId =
    annotation.anchor.kind === "route" ? annotation.anchor.routeId : routeId;
  const route = candidate.routes.find((item) => item.id === finalRouteId);
  if (!route) throw new Error("A named Wire needs a visible route");
  if (!context.symbolResolver || annotation.anchor.kind !== "route")
    throw new Error("A named Wire needs resolvable route geometry");
  const geometry = resolveRouteGeometry(
    candidate,
    context.symbolResolver,
    route,
  );
  const segment = geometry?.segments.find(
    (item) =>
      annotation.anchor.kind === "route" &&
      item.address.legId === annotation.anchor.legId,
  );
  if (!geometry || !segment)
    throw new Error("A named Wire needs resolvable route geometry");
  const anchor = {
    ...annotation.anchor,
    normalOffset: netLabelStandardOffset(
      segment.from,
      segment.to,
      netLabelBaselineForName(
        label.name,
        label.content,
        candidate.presentation,
        label.sizeScale,
      ),
    ),
  };
  const placement = resolveRouteAttachment(geometry, anchor);
  if (!placement)
    throw new Error("A named Wire needs resolvable route geometry");
  const naming = planEnsureNamedRoute(candidate, finalRouteId, {
    candidateNetId: route.netId,
    name: label.name,
    evidenceId: deriveStableId("signal-name", document.id, annotationId),
    owner: { kind: "net-label", annotationId },
  });
  if (!naming.ok) throw new Error(naming.message);
  return [
    ...authored,
    ...naming.edits,
    {
      kind: "upsert_schematic_annotation",
      annotation: {
        ...annotation,
        anchor: { ...anchor, fallbackPosition: placement.labelPoint },
        netId: naming.netId,
        binding: { kind: "net-name", netId: naming.netId },
        formatOverride: label.content,
      },
    },
  ];
}

/** GUI and Agent Label authoring share the same electrical decision. */
export function planEnsureNamedRoute(
  document: SchematicDocument,
  routeId: string,
  request: Parameters<typeof planEnsureNamedNet>[1],
  migration: SignalMigrationOptions = {},
  resolver?: SymbolResolver,
): EnsureNamedNetPlan {
  const route = document.routes.find((item) => item.id === routeId);
  if (request.owner.kind !== "net-label" || !route)
    return planEnsureNamedNet(document, request);
  const annotationId = request.owner.annotationId;
  const binding = document.annotations.find(
    (item) => item.id === annotationId,
  )?.binding;
  const selector =
    binding?.kind === "net-name" &&
    (binding.memberEndpoint !== undefined ||
      binding.memberEndpoints !== undefined);
  try {
    const unchangedLiteral = document.connectivityEvidence.some(
      (evidence) =>
        evidence.kind === "name-claim" &&
        !evidence.signal &&
        evidence.owner.kind === "net-label" &&
        evidence.owner.annotationId === annotationId &&
        evidence.name === request.name.trim(),
    );
    if (!unchangedLiteral) parseSignalExpression(request.name);
    if (
      (Object.keys(migration.memberMap ?? {}).length === 0 &&
        unchangedLiteral &&
        !migration.convertLegacy) ||
      (!route.members &&
        Object.keys(migration.memberMap ?? {}).length === 0 &&
        !selector &&
        !/[<>,]/u.test(request.name) &&
        !document.connectivityEvidence.some(
          (item) =>
            item.kind === "name-claim" &&
            item.owner.kind === "net-label" &&
            item.owner.annotationId === annotationId &&
            item.signal,
        ))
    )
      return planEnsureNamedNet(document, request);
    const edits = planSignalRouteName(
      document,
      route.id,
      request.name,
      request.owner.annotationId,
      migration,
      resolver,
    );
    const migrated = edits.find((edit) => edit.kind === "migrate_label_signal");
    let netId = route.netId;
    if (migrated?.kind === "migrate_label_signal") {
      const preview = structuredClone(document);
      applyLabelSignalMigration(preview, migrated, resolver);
      netId = preview.routes.find((item) => item.id === route.id)!.netId;
    }
    return {
      ok: true,
      netId,
      name: request.name.trim(),
      edits,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      relatedNetIds: [route.netId],
    };
  }
}

/** Establish a conductor's ordered identity through its ordinary Label owner. */
function planSignalRouteName(
  document: SchematicDocument,
  routeId: string,
  expression: string,
  annotationId: string,
  migration: SignalMigrationOptions = {},
  resolver?: SymbolResolver,
): SchematicEdit[] {
  const route = document.routes.find((candidate) => candidate.id === routeId);
  if (!route) throw new Error(`Route does not exist: ${routeId}`);
  const names = parseSignalExpression(expression);
  const name = expression.trim();
  const owner = document.annotations.find((item) => item.id === annotationId);
  if (
    owner?.binding?.kind === "net-name" &&
    (owner.binding.memberEndpoint || owner.binding.memberEndpoints)
  ) {
    if (
      Object.keys(migration.memberMap ?? {}).length === 0 &&
      foldNetName(flattenRichText(resolveAnnotationText(document, owner))) ===
        foldNetName(name)
    )
      return [];
    throw new Error(
      "A bus selector follows its selected member; changing that member requires an explicit migration",
    );
  }
  const existing = document.connectivityEvidence.find(
    (evidence) =>
      evidence.kind === "name-claim" &&
      evidence.owner.kind === "net-label" &&
      evidence.owner.annotationId === annotationId,
  );
  if (existing?.kind === "name-claim") {
    if (
      existing.name === name &&
      !migration.convertLegacy &&
      Object.keys(migration.memberMap ?? {}).length === 0
    )
      return [];
    if (existing.signal || migration.convertLegacy)
      return planLabelSignalMigration(
        document,
        routeId,
        annotationId,
        expression,
        migration,
        resolver,
      );
    if (
      /[<>\[\],]/u.test(existing.name) ||
      Object.keys(migration.memberMap ?? {}).length > 0
    )
      throw new Error(
        "Legacy scalar names require an explicit conversion and member mapping",
      );
  }
  if (!existing && Object.keys(migration.memberMap ?? {}).length > 0)
    throw new Error("Member mapping requires an existing signal naming owner");
  const edits: SchematicEdit[] = [];
  let members = route.members?.map((member) => ({
    id: member.id,
    netId: member.netId,
  }));
  if (!members && names.length > 1) {
    const net = document.nets.find((item) => item.id === route.netId);
    const routes = document.routes.filter((item) => item.netId === route.netId);
    const junctions = document.junctions.filter(
      (item) => item.netId === route.netId,
    );
    if (
      !net ||
      net.terminals.length ||
      routes.some(
        (item) =>
          item.members ||
          routeEndpoints(item).some((endpoint) => endpoint.kind !== "junction"),
      ) ||
      junctions.some((item) => item.members || item.contactAnchor) ||
      document.netlist?.terminals.some((item) => item.netId === net.id) ||
      document.connectivityEvidence.some(
        (item) => item.netId === net.id && item.id !== existing?.id,
      )
    ) {
      throw new Error(
        "A vector Label can establish width only on a loose unnamed conductor; fixed scalar contacts require a member selection",
      );
    }
    const netIds = names.map((_, index) =>
      index === 0
        ? net.id
        : deriveStableId("signal-net", net.id, String(index)),
    );
    const junctionMembers = new Map(
      junctions.map((junction) => [
        junction.id,
        netIds.map((netId, index) => ({
          id: deriveStableId("signal-member", junction.id, String(index)),
          netId,
        })),
      ]),
    );
    for (const junction of junctions)
      edits.push({
        kind: "set_junction_signal",
        junctionId: junction.id,
        members: junctionMembers.get(junction.id)!,
      });
    for (const conductor of routes) {
      const [start, end] = routeEndpoints(conductor);
      if (start.kind !== "junction" || end.kind !== "junction")
        throw new Error("Loose bus requires junction endpoints");
      const mapped = netIds.map((netId, index) => ({
        id: deriveStableId("signal-member", conductor.id, String(index)),
        netId,
        startMemberId: junctionMembers.get(start.junctionId)![index]!.id,
        endMemberId: junctionMembers.get(end.junctionId)![index]!.id,
      }));
      edits.push({
        kind: "set_route_path",
        route: { ...conductor, members: mapped },
      });
      if (conductor.id === route.id) members = mapped;
    }
  }
  if (members && members.length !== names.length)
    throw new Error("Label expression width must match the conductor");
  const signalMembers = (
    members ?? [
      {
        id: deriveStableId("signal-member", route.id, "0"),
        netId: route.netId,
      },
    ]
  ).map((member, index) => ({
    id: member.id,
    netId: member.netId,
    name: names[index]!,
  }));
  edits.push({
    kind: "upsert_connectivity_evidence",
    evidence: {
      id:
        existing?.id ??
        deriveStableId("signal-name", document.id, annotationId),
      kind: "name-claim",
      netId: route.netId,
      name,
      scope: "local",
      owner: { kind: "net-label", annotationId },
      signal: { expression: name, members: signalMembers },
    },
  });
  return edits;
}
