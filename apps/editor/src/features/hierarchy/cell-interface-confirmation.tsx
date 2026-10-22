import { useEffect, useMemo, useRef, useState } from "react";
import type { CellInterfaceConfirmation } from "./cell-interface-confirmation-types";

/** Native modal containment prevents clicks and keyboard edits behind the form. */
export function CellInterfaceConfirmationDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: CellInterfaceConfirmation;
  onCancel(): void;
  onConfirm(
    memberMap?: Record<string, string | null>,
    expression?: string,
  ): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [expression, setExpression] = useState(
    request.conversion?.expression ?? "",
  );
  const { migration, error } = useMemo(() => {
    try {
      return {
        migration: request.conversion
          ? request.conversion.preview(expression)
          : request.migration,
      };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [request, expression]);
  const [mapping, setMapping] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(
      (request.migration?.members ?? []).flatMap((member) =>
        member.target === undefined ? [] : [[member.id, member.target]],
      ),
    ),
  );
  const unresolved = migration?.members.some(
    (member) => mapping[member.id] === undefined,
  );
  const targets = Object.values(mapping).filter((value) => value !== null);
  const conflicting = new Set(targets).size !== targets.length;
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="editor-action-dialog"
      aria-labelledby="cell-interface-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="editor-action-dialog-header">
        <h2 id="cell-interface-confirm-title">{request.title}</h2>
      </header>
      <div className="editor-action-dialog-body">
        <p>{request.message}</p>
        {request.conversion && (
          <label className="editor-action-dialog-field">
            <span>Target signal expression</span>
            <input
              value={expression}
              placeholder="DATA<3:0>"
              onChange={(event) => {
                setExpression(event.target.value);
                setMapping({});
              }}
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        {migration && (
          <>
            <p aria-label="Signal member preview">
              {migration.targetNames.length} members ·{" "}
              {migration.targetNames.join(" → ")}
            </p>
            {migration.conversion && (
              <p>
                Existing scalar contacts keep one selected member, or
                disconnect.
              </p>
            )}
            <div className="cell-signal-migration">
              {migration.members.map((member) => (
                <label key={member.id}>
                  {member.name}
                  <select
                    aria-label={`Map ${member.name}`}
                    value={
                      mapping[member.id] === undefined
                        ? ""
                        : JSON.stringify(mapping[member.id])
                    }
                    onChange={(event) =>
                      setMapping((current) => ({
                        ...current,
                        [member.id]: JSON.parse(event.target.value) as
                          string | null,
                      }))
                    }
                  >
                    <option value="" disabled>
                      Choose member or disconnect
                    </option>
                    {migration.targetNames.map((name) => (
                      <option key={name} value={JSON.stringify(name)}>
                        {name}
                      </option>
                    ))}
                    <option value="null">Disconnect · keep wire stubs</option>
                  </select>
                </label>
              ))}
            </div>
            {conflicting && (
              <p role="alert">Each existing member needs a different target.</p>
            )}
            <ul>
              {migration.affected.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <footer className="editor-action-dialog-actions">
        <button type="button" autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          disabled={Boolean(error) || unresolved || conflicting}
          onClick={() =>
            onConfirm(
              migration ? mapping : undefined,
              request.conversion ? expression : undefined,
            )
          }
        >
          {request.confirmLabel}
        </button>
      </footer>
    </dialog>
  );
}
