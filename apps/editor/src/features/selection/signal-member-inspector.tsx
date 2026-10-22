import { useState } from "react";
import { foldNetName, parseSignalExpression } from "@icm/model";

export interface SignalMemberInspection {
  members: readonly {
    id: string;
    name: string;
    hasNet: boolean;
    noConnect: boolean;
  }[];
  selectedId?: string | undefined;
  onSelect(id: string): void;
  onTrace(id: string): void;
  onMark?: ((ids: readonly string[], marked: boolean) => void) | undefined;
}

/** Read-only inspection and explicit member sets share the existing Properties shelf. */
export function SignalMemberInspector({
  members,
  selectedId,
  onSelect,
  onTrace,
  onMark,
}: SignalMemberInspection) {
  const [expression, setExpression] = useState("");
  let selected: string[] = [];
  let error = "";
  if (expression.trim()) {
    try {
      selected = parseSignalExpression(expression).map((name) => {
        const matches = members.filter(
          (member) => foldNetName(member.name) === foldNetName(name),
        );
        if (matches.length !== 1)
          throw new Error(`Choose one existing member for ${name}`);
        return matches[0]!.id;
      });
    } catch (issue) {
      error = issue instanceof Error ? issue.message : "Invalid member set";
    }
  }
  return (
    <section aria-label="Signal members">
      <label>
        Inspect member
        <select
          aria-label="Inspect member"
          value={selectedId ?? ""}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="" disabled>
            Choose a member…
          </option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name} ·{" "}
              {member.noConnect
                ? "No Connect"
                : member.hasNet
                  ? "On a Net"
                  : "Unconnected"}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={
          !selectedId ||
          !members.find((member) => member.id === selectedId)?.hasNet
        }
        onClick={() => selectedId && onTrace(selectedId)}
      >
        Trace member
      </button>
      {onMark ? (
        <>
          <label>
            No Connect member set
            <input
              aria-label="No Connect member set"
              placeholder="DATA<3,1>"
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
            />
          </label>
          {error ? (
            <small role="alert">{error}</small>
          ) : selected.length ? (
            <small>{selected.length} explicit members</small>
          ) : null}
          <button
            type="button"
            disabled={!selected.length || Boolean(error)}
            onClick={() => onMark(selected, true)}
          >
            Mark selected members No Connect
          </button>
          <button
            type="button"
            disabled={!selected.length || Boolean(error)}
            onClick={() => onMark(selected, false)}
          >
            Clear selected No Connect
          </button>
        </>
      ) : null}
    </section>
  );
}
