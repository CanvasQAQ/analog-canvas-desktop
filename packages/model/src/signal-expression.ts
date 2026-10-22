import type { ConnectivityEvidence, SchematicDocument } from "./schema.js";

/** Read-only scalar names from each owner; no copied editable name claims. */
export function scalarConnectivityEvidence(
  document: SchematicDocument,
): ConnectivityEvidence[] {
  return document.connectivityEvidence.flatMap((evidence) =>
    evidence.kind === "name-claim" && evidence.signal
      ? evidence.signal.members.map((member) => ({
          ...evidence,
          id: `${evidence.id}/${member.id}`,
          netId: member.netId,
          name: member.name,
          signal: undefined,
        }))
      : [evidence],
  );
}

/** The explicitly authored signal grammar. Loading names never calls this parser. */
export function parseSignalExpression(expression: string): readonly string[] {
  const text = expression.trim();
  if (!text || text.length > 256)
    throw new Error("A signal expression needs 1–256 characters");
  if (text.includes(","))
    throw new Error("Ordered subsets and mixed bundles are not supported yet");
  const match = /^([^<>\[\]\s:,]+)<(\d+)(?::(\d+))?>$/u.exec(text);
  if (!match) {
    if (/[<>\[\]:]/u.test(text))
      throw new Error("Use a scalar name, NAME<index>, or NAME<first:last>");
    if (/\s/u.test(text))
      throw new Error("A signal name cannot contain whitespace");
    return [text];
  }
  const first = Number(match[2]);
  const last = Number(match[3] ?? match[2]);
  if (first > 65535 || last > 65535)
    throw new Error("Signal indices must be between 0 and 65535");
  const width = Math.abs(last - first) + 1;
  if (width > 256) throw new Error("A signal may contain at most 256 members");
  return Array.from(
    { length: width },
    (_, index) => `${match[1]}<${first + index * (last < first ? -1 : 1)}>`,
  );
}
