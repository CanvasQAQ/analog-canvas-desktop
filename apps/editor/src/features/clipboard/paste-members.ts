import {
  deriveStableId,
  type RouteEndpoint,
  type CellNetlistTerminal,
} from "@icm/model";
import type { SchematicClipboard } from "./clipboard";
import { mapEndpoint } from "./paste-remap";
type SignalDeclaration = NonNullable<CellNetlistTerminal["signal"]>;

/** Member identity belongs to its declaration/contact, not to its spelling.
 * In particular, a detached stub may retain the ID of a reused child formal.
 */
export function pastedMembers(
  clipboard: SchematicClipboard,
  objects: ReadonlyMap<string, string>,
  nets: ReadonlyMap<string, string>,
  instances: ReadonlyMap<string, string>,
  junctions: ReadonlyMap<string, string>,
) {
  const member = (kind: string, owner: string, id: string) =>
    deriveStableId(
      "copy-member",
      clipboard.sourceDocumentId,
      kind,
      objects.get(owner)!,
      id,
    );
  const endpoint = (source: RouteEndpoint): RouteEndpoint => {
    const mapped = mapEndpoint(source, instances, junctions);
    if (!source.memberId) return mapped;
    if (source.kind === "junction")
      return {
        ...mapped,
        memberId: member("junction", source.junctionId, source.memberId),
      };
    const formal = clipboard.cellTerminals.find((terminal) =>
      terminal.interfaceInstanceIds.includes(source.instanceId),
    );
    return formal
      ? { ...mapped, memberId: member("formal", formal.id, source.memberId) }
      : mapped;
  };
  const signal = (
    kind: "formal" | "claim",
    owner: string,
    source: SignalDeclaration,
  ): SignalDeclaration => ({
    ...source,
    members: source.members.map((item) => ({
      ...item,
      id: member(kind, owner, item.id),
      netId: nets.get(item.netId)!,
    })),
  });
  const route = (source: SchematicClipboard["routes"][number]) =>
    source.members?.map((lane) => {
      // Naming an aggregate makes its lane identities aliases of the claim's members.
      const claim = clipboard.connectivityEvidence.find(
        (evidence) =>
          evidence.kind === "name-claim" &&
          evidence.signal?.members.some(
            (item) => item.id === lane.id && item.netId === lane.netId,
          ),
      );
      const end = source.legs.at(-1)!.to;
      if (end.kind !== "endpoint")
        throw new Error("Copied Route has no endpoint");
      return {
        ...lane,
        id: member(claim ? "claim" : "route", claim?.id ?? source.id, lane.id),
        netId: nets.get(lane.netId)!,
        startMemberId: endpoint({
          ...source.start,
          memberId: lane.startMemberId,
        }).memberId!,
        endMemberId: endpoint({ ...end.endpoint, memberId: lane.endMemberId })
          .memberId!,
      };
    });
  return { member, endpoint, signal, route };
}
