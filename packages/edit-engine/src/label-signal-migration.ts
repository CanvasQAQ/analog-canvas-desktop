import {
  createRoutePath,
  deriveStableId,
  foldNetName,
  parseSignalExpression,
  renamedLabelFormat,
  routeEnd,
  type RouteEndpoint,
  routeElectricalConnections,
  type SchematicDocument,
} from "@icm/model";
import {
  endpointKey,
  resolveAnnotationName,
  resolveEndpointConnection,
} from "@icm/derived";
import type { SymbolResolver } from "@icm/symbols";
import {
  planSignalMemberMigration,
  type SignalMigrationOptions,
} from "./signal-member-migration.js";
import type { SchematicEdit } from "./edit-schema.js";
import { z } from "zod";
import { routeIsProtected, lockedLayoutOwner } from "./transaction-routing.js";
import {
  captureLockedAnnotations,
  assertLockedAnnotationsUnchanged,
} from "./annotation-locks.js";

export const LabelSignalMigrationEditSchema = z.strictObject({
  kind: z.literal("migrate_label_signal"),
  routeId: z.string().min(1),
  annotationId: z.string().min(1),
  expression: z.string().min(1).max(256),
  memberMap: z
    .record(z.string().min(1), z.string().min(1).max(256).nullable())
    .optional(),
  convertLegacy: z.boolean().optional(),
});
type LabelSignalMigrationEdit = z.infer<typeof LabelSignalMigrationEditSchema>;

export function previewLabelSignalMigration(
  document: SchematicDocument,
  annotationId: string,
  expression: string,
) {
  const claim = document.connectivityEvidence.find(
    (item) =>
      item.kind === "name-claim" &&
      item.owner.kind === "net-label" &&
      item.owner.annotationId === annotationId,
  );
  if (claim?.kind !== "name-claim")
    throw new Error("Label naming owner is unavailable");
  const targetNames = parseSignalExpression(expression);
  const previous = claim.signal?.members ?? [
    { id: claim.id, name: claim.name, netId: claim.netId },
  ];
  const nets = new Set(previous.map((member) => member.netId));
  return {
    members: previous.map((member) => {
      const target = targetNames.find(
        (name) => foldNetName(name) === foldNetName(member.name),
      );
      return {
        id: member.id,
        name: member.name,
        ...(target ? { target } : {}),
      };
    }),
    targetNames,
    conversion: !claim.signal,
    affected: document.routes
      .filter(
        (route) =>
          nets.has(route.netId) ||
          route.members?.some((member) => nets.has(member.netId)),
      )
      .map((route) => `Wire ${route.id}`),
  };
}

/** Migrate one naming owner; other claims are never rewritten by text. */
export function planLabelSignalMigration(
  document: SchematicDocument,
  routeId: string,
  annotationId: string,
  expression: string,
  options: SignalMigrationOptions = {},
  resolver?: SymbolResolver,
): SchematicEdit[] {
  const edit: LabelSignalMigrationEdit = {
    kind: "migrate_label_signal",
    routeId,
    annotationId,
    expression,
    ...options,
  };
  applyLabelSignalMigration(structuredClone(document), edit, resolver);
  return [edit];
}

export function applyLabelSignalMigration(
  document: SchematicDocument,
  edit: LabelSignalMigrationEdit,
  resolver?: SymbolResolver,
): void {
  const lockedAnnotations = captureLockedAnnotations(document);
  const { routeId, annotationId, expression } = edit;
  const route = document.routes.find((item) => item.id === routeId);
  const annotation = document.annotations.find(
    (item) => item.id === annotationId,
  );
  const claim = document.connectivityEvidence.find(
    (item) =>
      item.kind === "name-claim" &&
      item.owner.kind === "net-label" &&
      item.owner.annotationId === annotationId,
  );
  if (!route || !annotation || claim?.kind !== "name-claim")
    throw new Error("Signal naming owner is unavailable");
  if (routeIsProtected(route) || lockedLayoutOwner(document, route.id))
    throw new Error(
      `Route is protected by a locked segment or layout intent: ${route.id}`,
    );
  if (
    claim.signal?.members.length && claim.signal.members.length > 1
      ? route.members?.length !== claim.signal.members.length ||
        claim.signal.members.some(
          (member) =>
            !route.members?.some(
              (lane) => lane.id === member.id && lane.netId === member.netId,
            ),
        )
      : route.netId !== claim.netId || route.members !== undefined
  )
    throw new Error("Label migration must target its owned conductor");
  if (annotation.locked)
    throw new Error("Unlock the Label before migrating its signal");
  if (
    annotation.binding?.kind === "net-name" &&
    (annotation.binding.memberEndpoint || annotation.binding.memberEndpoints)
  )
    throw new Error("A selector cannot become a signal naming owner");
  const selectors = document.annotations.filter(
    (item) =>
      item.anchor.kind === "route" &&
      item.anchor.routeId === route.id &&
      item.binding?.kind === "net-name" &&
      (item.binding.memberEndpoint || item.binding.memberEndpoints),
  );
  const previousSelectorNames = new Map(
    selectors.map((item) => [item.id, resolveAnnotationName(document, item)]),
  );
  if (!claim.signal && !edit.convertLegacy)
    throw new Error(
      "Legacy scalar conversion requires an explicit conversion action",
    );
  const previous = claim.signal?.members ?? [
    { id: claim.id, name: claim.name, netId: claim.netId },
  ];
  const migration = planSignalMemberMigration(
    claim.id,
    previous,
    expression,
    {
      ...(edit.memberMap ? { memberMap: edit.memberMap } : {}),
      ...(edit.convertLegacy ? { convertLegacy: true } : {}),
    },
    String(document.revision),
  );
  if (migration.unresolved.length)
    throw new Error(
      "Explicit member migration mapping or disconnect is required",
    );
  const members = migration.members;
  const detachSelectors =
    selectors.length > 0 &&
    !members.some((member) => previous.some((old) => old.id === member.id));
  if (detachSelectors) {
    const detached = structuredClone(route);
    detached.id = deriveStableId(
      "signal-detached-route",
      route.id,
      String(document.revision),
    );
    const legIds = new Map(
      detached.legs.map((leg) => [
        leg.id,
        deriveStableId("route-leg", detached.id, leg.id),
      ]),
    );
    for (const leg of detached.legs) leg.id = legIds.get(leg.id)!;
    document.routes.push(detached);
    for (const selector of selectors)
      if (selector.anchor.kind === "route")
        selector.anchor = {
          ...selector.anchor,
          routeId: detached.id,
          legId: legIds.get(selector.anchor.legId)!,
        };
  }
  const originalStart = route.start;
  const originalEnd = routeEnd(route);
  const oldLanes = route.members ?? [
    {
      id: previous[0]!.id,
      netId: route.netId,
      startMemberId: originalStart.memberId,
      endMemberId: originalEnd.memberId,
    },
  ];
  let lanes = members.map((member) =>
    oldLanes.find((lane) => lane.id === member.id),
  );
  if (lanes.some((lane) => !lane)) {
    for (const member of members)
      if (!document.nets.some((net) => net.id === member.netId))
        document.nets.push({ id: member.netId, terminals: [] });
    const anchor = (endpoint: RouteEndpoint, side: "start" | "end") => {
      const connection = resolver
        ? resolveEndpointConnection(document, resolver, endpoint)
        : undefined;
      const junction =
        endpoint.kind === "junction"
          ? document.junctions.find((item) => item.id === endpoint.junctionId)
          : undefined;
      const point = junction?.position ?? connection?.gridLanding;
      if (!point)
        throw new Error("Signal migration needs resolvable endpoint geometry");
      const id = deriveStableId(
        "signal-anchor",
        route.id,
        side,
        String(document.revision),
      );
      const nextMembers = members.map((member) => ({
        id: deriveStableId("signal-member", id, member.id),
        netId: member.netId,
      }));
      const direction = connection?.outward ?? { x: 0, y: 1 };
      document.junctions.push({
        id,
        netId: members[0]!.netId,
        position: {
          x: point.x + direction.x * document.presentation.grid,
          y: point.y + direction.y * document.presentation.grid,
        },
        ...(members.length > 1 ? { members: nextMembers } : {}),
      });
      for (const member of members) {
        const old = oldLanes.find((lane) => lane.id === member.id);
        if (!old) continue;
        const oldMember =
          side === "start" ? old.startMemberId : old.endMemberId;
        const source = {
          ...endpoint,
          ...(oldMember ? { memberId: oldMember } : {}),
        };
        const target = {
          kind: "junction" as const,
          junctionId: id,
          ...(members.length > 1
            ? { memberId: nextMembers[members.indexOf(member)]!.id }
            : {}),
        };
        document.routes.push(
          createRoutePath({
            id: deriveStableId("signal-bridge", id, member.id),
            netId: member.netId,
            start: source,
            end: target,
            bends: [],
            modes: ["manual"],
          }),
        );
      }
      return {
        endpoint: { kind: "junction" as const, junctionId: id },
        members: nextMembers,
      };
    };
    const start = anchor(originalStart, "start");
    const end = anchor(originalEnd, "end");
    route.start = start.endpoint;
    route.legs.at(-1)!.to = { kind: "endpoint", endpoint: end.endpoint };
    lanes = members.map((member, index) => ({
      id: member.id,
      netId: member.netId,
      startMemberId: members.length > 1 ? start.members[index]!.id : undefined,
      endMemberId: members.length > 1 ? end.members[index]!.id : undefined,
    }));
  }
  const netId = members[0]!.netId;
  const name = expression.trim();
  const formatOverride = renamedLabelFormat(
    annotation,
    resolveAnnotationName(document, annotation),
    name,
    document.presentation,
  );
  route.netId = netId;
  if (members.length > 1)
    route.members = lanes.map((lane) => {
      if (!lane?.startMemberId || !lane.endMemberId)
        throw new Error(
          "Aggregate members require qualified endpoint mappings",
        );
      return {
        ...lane,
        startMemberId: lane.startMemberId,
        endMemberId: lane.endMemberId,
      };
    });
  else {
    const lane = lanes[0]!;
    route.start = {
      ...route.start,
      ...(lane.startMemberId ? { memberId: lane.startMemberId } : {}),
    };
    route.legs.at(-1)!.to = {
      kind: "endpoint",
      endpoint: {
        ...routeEnd(route),
        ...(lane.endMemberId ? { memberId: lane.endMemberId } : {}),
      },
    };
    delete route.members;
  }
  claim.name = name;
  claim.netId = netId;
  claim.signal = { expression: name, members };
  annotation.netId = netId;
  annotation.binding = { kind: "net-name", netId };
  if (formatOverride) annotation.formatOverride = formatOverride;
  for (const selector of selectors) {
    if (!detachSelectors) {
      const oldBinding = selector.binding;
      const oldKeys = new Set(
        oldBinding?.kind === "net-name"
          ? (
              oldBinding.memberEndpoints ??
              (oldBinding.memberEndpoint ? [oldBinding.memberEndpoint] : [])
            ).map(endpointKey)
          : [],
      );
      const endpoints = routeElectricalConnections(route).map((edge) => {
        const qualified =
          edge.endpoints.find(
            (endpoint) =>
              endpoint.memberId && oldKeys.has(endpointKey(endpoint)),
          ) ?? edge.endpoints.find((endpoint) => endpoint.memberId);
        if (!qualified?.memberId)
          throw new Error(
            "A bound selector requires a selected member endpoint",
          );
        return { ...qualified, memberId: qualified.memberId };
      });
      selector.netId = netId;
      selector.binding =
        endpoints.length === 1
          ? { kind: "net-name", netId, memberEndpoint: endpoints[0]! }
          : { kind: "net-name", netId, memberEndpoints: endpoints };
    }
    const format = renamedLabelFormat(
      selector,
      previousSelectorNames.get(selector.id)!,
      resolveAnnotationName(document, selector),
      document.presentation,
    );
    if (format) selector.formatOverride = format;
  }
  assertLockedAnnotationsUnchanged(document, lockedAnnotations);
}
