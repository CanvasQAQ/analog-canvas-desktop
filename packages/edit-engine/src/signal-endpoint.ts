import {
  deriveStableId,
  type RouteEndpoint,
  type SchematicDocument,
} from "@icm/model";
import { resolveDocumentLogicalNets } from "@icm/derived";
import type { SymbolResolver } from "@icm/symbols";

/** Read aggregate membership from the electrical declaration, never label spelling. */
export function signalEndpointMembers(
  document: SchematicDocument,
  resolver: SymbolResolver,
  endpoint: RouteEndpoint,
): Array<{ id: string; netId: string; name?: string }> | undefined {
  if (endpoint.memberId) return undefined;
  if (endpoint.kind === "junction") {
    const members = document.junctions.find(
      (item) => item.id === endpoint.junctionId,
    )?.members;
    if (!members) return undefined;
    const logical = resolveDocumentLogicalNets(document);
    return members.map((member) => ({
      ...member,
      ...(logical.byBaseNetId.get(member.netId)?.name
        ? { name: logical.byBaseNetId.get(member.netId)!.name! }
        : {}),
    }));
  }
  const declaration = document.netlist?.terminals.find(
    (item) =>
      item.interfaceInstanceIds.includes(endpoint.instanceId) &&
      endpoint.pinName === "P",
  );
  if (declaration?.signal && declaration.signal.members.length > 1)
    return declaration.signal.members;
  const instance = document.instances.find(
    (item) => item.id === endpoint.instanceId,
  );
  const members =
    instance &&
    resolver
      .resolve(instance.symbolId, instance.symbolVariantId)
      ?.definition.pins.find((pin) => pin.name === endpoint.pinName)
      ?.signalMembers;
  if (!members) return undefined;
  return members.map((member) => ({
    ...member,
    netId:
      document.nets.find((net) =>
        net.terminals.some(
          (terminal) =>
            terminal.instanceId === endpoint.instanceId &&
            terminal.pinName === endpoint.pinName &&
            terminal.memberId === member.id,
        ),
      )?.id ?? deriveStableId("signal-net", endpoint.instanceId, member.id),
  }));
}
