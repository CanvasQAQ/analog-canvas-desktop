import { deriveStableId, foldNetName, parseSignalExpression } from "@icm/model";

export interface SignalMigrationOptions {
  /** Existing stable member ID to its requested name, or null to disconnect. */
  memberMap?: Readonly<Record<string, string | null>>;
  /** Deliberate adoption of a literal legacy scalar name. Never inferred on read. */
  convertLegacy?: boolean;
}

export interface SignalMemberIdentity {
  id: string;
  name: string;
  netId: string;
}

/** Matching names retain identity; every other correspondence is explicit. */
export function planSignalMemberMigration(
  ownerId: string,
  oldMembers: readonly SignalMemberIdentity[],
  expression: string,
  options: SignalMigrationOptions = {},
  generation = "",
) {
  const names = parseSignalExpression(expression);
  const assignments = new Map<string, SignalMemberIdentity>();
  for (const [id, name] of Object.entries(options.memberMap ?? {})) {
    if (!oldMembers.some((member) => member.id === id))
      throw new Error(`Unknown source member: ${id}`);
    if (
      name !== null &&
      !names.some((next) => foldNetName(next) === foldNetName(name))
    )
      throw new Error(`Unknown target member: ${name}`);
  }
  const removed: SignalMemberIdentity[] = [];
  for (const member of oldMembers) {
    const mapped =
      options.memberMap && Object.hasOwn(options.memberMap, member.id)
        ? options.memberMap[member.id]
        : undefined;
    const target =
      mapped === undefined
        ? names.find((name) => foldNetName(name) === foldNetName(member.name))
        : mapped;
    if (target == null) {
      removed.push(member);
      continue;
    }
    const key = foldNetName(target);
    if (assignments.has(key))
      throw new Error(`Multiple existing members cannot map to ${target}`);
    assignments.set(key, member);
  }
  const members = names.map((name) => {
    const old = assignments.get(foldNetName(name));
    return old
      ? { ...old, name }
      : {
          id: deriveStableId("signal-member", ownerId, generation, name),
          name,
          netId: deriveStableId("signal-net", ownerId, generation, name),
        };
  });
  return {
    members,
    removed,
    unresolved: removed.filter(
      (member) => options.memberMap?.[member.id] !== null,
    ),
  };
}
