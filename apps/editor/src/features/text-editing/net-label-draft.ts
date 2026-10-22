import {
  flattenRichText,
  hasRichTextOverbar,
  labelTextDocument,
  labelTypography,
  rewriteRichTextIdentifier,
  roleLabelFormat,
  type RichTextDocument,
  type SchematicDocument,
} from "@icm/model";

/** Ordinary Label placement and inline Wire naming create the same name and look. */
export function prepareNetLabelDraft(
  draft: RichTextDocument,
  presentation: SchematicDocument["presentation"],
): {
  name: string;
  content: RichTextDocument;
  formatOverride?: RichTextDocument;
} {
  // Scalar complement shorthand remains available. Explicit signal
  // expressions keep their electrical characters when formatted.
  const plainText = flattenRichText(draft);
  const typography = labelTypography(presentation);
  const typedName = plainText.trim();
  const name =
    hasRichTextOverbar(draft) &&
    !/[<>,]/u.test(typedName) &&
    !typedName.endsWith("_bar")
      ? `${typedName}_bar`
      : typedName;
  const content =
    plainText === typedName && !plainText.includes("_")
      ? draft
      : rewriteRichTextIdentifier(draft, name, {
          underscoreSubscript:
            typography.subscriptAfterFirst || typography.underscoreSubscript,
        });
  const semanticContent = labelTextDocument(name, presentation);
  if (JSON.stringify(content) !== JSON.stringify(semanticContent))
    return { name, content, formatOverride: content };
  const standard = roleLabelFormat("voltage-node", name);
  return standard
    ? { name, content: standard, formatOverride: standard }
    : { name, content };
}
