import { resolveDocumentLogicalNets } from "@icm/derived";
import { isFreeWireAnchor, type WireSource } from "./wire-commit-planner.js";
import type { SchematicDocument } from "@icm/model";

export interface WireMemberOption {
  id: string;
  label: string;
}
export interface WireMemberChoice {
  source: WireSource;
  options: readonly WireMemberOption[];
  allowWhole: boolean;
}
export type WireMemberEvaluation =
  | { kind: "ready"; from: WireSource; to: WireSource }
  | { kind: "choose"; side: "from" | "to"; choice: WireMemberChoice }
  | { kind: "invalid"; message: string };

export function selectWireMember(
  source: WireSource,
  memberId: string,
): WireSource {
  const member = source.members?.find((item) => item.id === memberId);
  if (!member) throw new Error("That bus member is no longer available");
  const { members: _members, ...scalar } = source;
  const endpoint = { ...source.endpoint, memberId };
  return {
    ...scalar,
    endpoint,
    netId: member.netId,
    connection: { ...source.connection, endpoint },
  };
}

export function wireMemberChoice(
  document: SchematicDocument,
  source: WireSource,
  allowWhole: boolean,
): WireMemberChoice {
  const logical = resolveDocumentLogicalNets(document);
  return {
    source,
    allowWhole,
    options: (source.members ?? []).map((member, index) => ({
      id: member.id,
      label:
        logical.byBaseNetId.get(member.netId)?.name ??
        member.name ??
        `Member ${index + 1}`,
    })),
  };
}

/** The one electrical choice shared by hover and click. Child formal names are display hints only. */
export function evaluateWireMembers(
  document: SchematicDocument,
  from: WireSource,
  to: WireSource,
): WireMemberEvaluation {
  if (from.members && to.members)
    return from.members.length === to.members.length
      ? { kind: "ready", from, to }
      : {
          kind: "invalid",
          message: `Bus widths differ: ${from.members.length} and ${to.members.length}`,
        };
  if (!from.members && !to.members) return { kind: "ready", from, to };
  const side = from.members ? "from" : "to";
  const aggregate = from.members ? from : to;
  const scalar = from.members ? to : from;
  if (isFreeWireAnchor(scalar)) return { kind: "ready", from, to };
  const logical = resolveDocumentLogicalNets(document);
  const scalarName = scalar.netId
    ? logical.byBaseNetId.get(scalar.netId)?.name
    : undefined;
  const matches = aggregate.members!.filter(
    (member) =>
      member.netId === scalar.netId ||
      (scalarName !== undefined &&
        scalarName === logical.byBaseNetId.get(member.netId)?.name),
  );
  if (matches.length === 1) {
    const selected = selectWireMember(aggregate, matches[0]!.id);
    return {
      kind: "ready",
      from: side === "from" ? selected : from,
      to: side === "to" ? selected : to,
    };
  }
  return {
    kind: "choose",
    side,
    choice: wireMemberChoice(document, aggregate, false),
  };
}
