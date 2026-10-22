import type { SchematicDocument } from "@icm/model";

/** Migration can change bindings as well as presentation; both obey locks. */
export function captureLockedAnnotations(document: SchematicDocument) {
  return new Map(
    document.annotations
      .filter((annotation) => annotation.locked)
      .map((annotation) => [annotation.id, JSON.stringify(annotation)]),
  );
}

export function assertLockedAnnotationsUnchanged(
  document: SchematicDocument,
  locked: ReadonlyMap<string, string>,
): void {
  for (const [id, before] of locked)
    if (
      JSON.stringify(
        document.annotations.find((annotation) => annotation.id === id),
      ) !== before
    )
      throw new Error(`Annotation is locked: ${id}`);
}
