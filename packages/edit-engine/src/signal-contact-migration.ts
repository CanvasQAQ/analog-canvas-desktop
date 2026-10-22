import {
  createRoutePath,
  deriveStableId,
  routeEnd,
  type RouteEndpoint,
  type SchematicDocument,
} from "@icm/model";
import { resolveEndpointConnection } from "@icm/derived";
import type { SymbolResolver } from "@icm/symbols";
import type { SignalMemberIdentity } from "./signal-member-migration.js";
import { routeIsProtected, lockedLayoutOwner } from "./transaction-routing.js";

/** Preserve existing lane geometry, bridging surviving identities at a resized Pin. */
export function migrateSignalContacts(
  document: SchematicDocument,
  resolver: SymbolResolver,
  target: { instanceId: string; pinName: string; nextName: string },
  previous: readonly SignalMemberIdentity[],
  next: readonly SignalMemberIdentity[],
) {
  const surviving = new Set(next.map((member) => member.id));
  const matches = (endpoint: RouteEndpoint) =>
    endpoint.kind === "terminal" &&
    endpoint.instanceId === target.instanceId &&
    endpoint.pinName === target.pinName;
  const detached = new Map<string, RouteEndpoint>();
  const rename = (endpoint: RouteEndpoint, routeId?: string): RouteEndpoint => {
    if (!matches(endpoint)) return endpoint;
    const id = endpoint.memberId ?? previous[0]!.id;
    const replacement = detached.get(`${routeId}/${id}`);
    if ((!surviving.has(id) || next.length === 1) && replacement)
      return replacement;
    const { memberId: _memberId, ...rest } = endpoint;
    return {
      ...rest,
      pinName: target.nextName,
      ...(next.length > 1 && (endpoint.memberId || previous.length === 1)
        ? { memberId: id }
        : {}),
    } as RouteEndpoint;
  };
  for (const route of [...document.routes]) {
    for (const side of ["start", "end"] as const) {
      const endpoint = side === "start" ? route.start : routeEnd(route);
      if (!matches(endpoint)) continue;
      if (routeIsProtected(route) || lockedLayoutOwner(document, route.id))
        throw new Error(
          `Route is protected by a locked segment or layout intent: ${route.id}`,
        );
      const lanes = route.members?.map((member) => ({
        id: side === "start" ? member.startMemberId : member.endMemberId,
        netId: member.netId,
      })) ?? [{ id: endpoint.memberId ?? previous[0]!.id, netId: route.netId }];
      const needsStub =
        lanes.some((member) => !surviving.has(member.id)) ||
        ((route.members || endpoint.memberId) && next.length === 1);
      if (!needsStub) {
        const updated = route.members
          ? ({ ...endpoint, pinName: target.nextName } as RouteEndpoint)
          : rename(endpoint);
        if (side === "start") route.start = updated;
        else route.legs.at(-1)!.to = { kind: "endpoint", endpoint: updated };
        continue;
      }
      const connection = resolveEndpointConnection(
        document,
        resolver,
        endpoint,
      );
      if (!connection)
        throw new Error(
          `Cannot retain wire stubs for ${target.instanceId}.${target.pinName}`,
        );
      const junctionId = deriveStableId(
        "signal-stub",
        route.id,
        side,
        String(document.revision),
      );
      const outward = connection.outward ?? { x: 1, y: 0 };
      const stub = { kind: "junction" as const, junctionId };
      const stubMembers =
        lanes.length === 1 && endpoint.memberId
          ? previous.map((member) => ({
              id: member.id,
              netId:
                document.nets.find((net) =>
                  net.terminals.some(
                    (terminal) =>
                      terminal.instanceId === target.instanceId &&
                      terminal.pinName === target.pinName &&
                      terminal.memberId === member.id,
                  ),
                )?.id ?? deriveStableId("signal-net", junctionId, member.id),
            }))
          : lanes;
      for (const member of stubMembers)
        if (!document.nets.some((net) => net.id === member.netId))
          document.nets.push({ id: member.netId, terminals: [] });
      const stubEndpoint = {
        ...stub,
        ...(lanes.length === 1 && stubMembers.length > 1
          ? { memberId: lanes[0]!.id }
          : {}),
      };
      document.junctions.push({
        id: junctionId,
        netId: stubMembers[0]!.netId,
        position: {
          x: connection.gridLanding.x + outward.x * document.presentation.grid,
          y: connection.gridLanding.y + outward.y * document.presentation.grid,
        },
        ...(stubMembers.length > 1 ? { members: stubMembers } : {}),
      });
      for (const lane of lanes)
        detached.set(`${route.id}/${lane.id}`, {
          ...stub,
          ...(stubMembers.length > 1 ? { memberId: lane.id } : {}),
        });
      if (side === "start") route.start = stubEndpoint;
      else route.legs.at(-1)!.to = { kind: "endpoint", endpoint: stubEndpoint };
      const retained = next.flatMap((member) =>
        lanes.filter((lane) => lane.id === member.id),
      );
      if (retained.length) {
        const id = deriveStableId("signal-bridge", junctionId);
        document.routes.push(
          createRoutePath({
            id,
            netId: retained[0]!.netId,
            start: {
              kind: "terminal",
              instanceId: target.instanceId,
              pinName: target.nextName,
              ...(retained.length === 1 && next.length > 1
                ? { memberId: retained[0]!.id }
                : {}),
            },
            end: {
              ...stub,
              ...(retained.length === 1 && stubMembers.length > 1
                ? { memberId: retained[0]!.id }
                : {}),
            },
            bends: [],
            modes: ["manual"],
            ...(retained.length > 1
              ? {
                  members: retained.map((member) => ({
                    id: deriveStableId("signal-member", id, member.id),
                    netId: member.netId,
                    startMemberId: member.id,
                    endMemberId: member.id,
                  })),
                }
              : {}),
            ...(route.presentation ? { presentation: route.presentation } : {}),
            ...(route.styleOverride
              ? { styleOverride: route.styleOverride }
              : {}),
            ...(route.documentStyle
              ? { documentStyle: route.documentStyle }
              : {}),
          }),
        );
      }
    }
  }
  for (const annotation of document.annotations) {
    if (annotation.binding?.kind !== "net-name") continue;
    const routeId =
      annotation.anchor.kind === "route"
        ? annotation.anchor.routeId
        : undefined;
    if (annotation.binding.memberEndpoint)
      annotation.binding.memberEndpoint = rename(
        annotation.binding.memberEndpoint,
        routeId,
      );
    if (annotation.binding.memberEndpoints)
      annotation.binding.memberEndpoints =
        annotation.binding.memberEndpoints.map((endpoint) =>
          rename(endpoint, routeId),
        );
  }
}
