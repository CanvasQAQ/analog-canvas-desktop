import {
  deriveStableId,
  parseSignalExpression,
  routeEndpoints,
  type SchematicDocument,
} from "@icm/model";
import type { SchematicEdit } from "./edit-schema.js";
import {
  planEnsureNamedNet,
  type EnsureNamedNetPlan,
} from "./named-net-planner.js";
import { resolveDocumentLogicalNets } from "@icm/derived";

/** GUI and Agent Label authoring share the same electrical decision. */
export function planEnsureNamedRoute(
  document: SchematicDocument,
  routeId: string,
  request: Parameters<typeof planEnsureNamedNet>[1],
): EnsureNamedNetPlan {
  const route = document.routes.find((item) => item.id === routeId);
  if (request.owner.kind !== "net-label" || !route)
    return planEnsureNamedNet(document, request);
  const annotationId = request.owner.annotationId;
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
      unchangedLiteral ||
      (!route.members &&
        !routeEndpoints(route).some((endpoint) => endpoint.memberId) &&
        !/[<>]/u.test(request.name))
    )
      return planEnsureNamedNet(document, request);
    return {
      ok: true,
      netId: route.netId,
      name: request.name.trim(),
      edits: planSignalRouteName(
        document,
        route.id,
        request.name,
        request.owner.annotationId,
      ),
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
): SchematicEdit[] {
  const route = document.routes.find((candidate) => candidate.id === routeId);
  if (!route) throw new Error(`Route does not exist: ${routeId}`);
  const names = parseSignalExpression(expression);
  const name = expression.trim();
  if (
    !route.members &&
    routeEndpoints(route).some((endpoint) => endpoint.memberId)
  ) {
    if (
      resolveDocumentLogicalNets(document).byBaseNetId.get(route.netId)
        ?.name === name
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
    if (existing.name === name) return [];
    if (existing.signal)
      throw new Error(
        "Connected bus rename requires interface migration, which is not supported yet",
      );
    if (/[<>]/u.test(existing.name))
      throw new Error(
        "Legacy bracketed labels remain scalar; explicit conversion is not supported yet",
      );
  }
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
