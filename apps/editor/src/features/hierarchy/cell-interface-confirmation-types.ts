export interface SignalMigrationPreview {
  members: { id: string; name: string; target?: string | null }[];
  targetNames: readonly string[];
  affected: string[];
  conversion: boolean;
}

export interface CellInterfaceConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  apply(
    memberMap?: Record<string, string | null>,
    expression?: string,
  ): boolean;
  migration?: SignalMigrationPreview;
  conversion?: {
    expression: string;
    preview(expression: string): SignalMigrationPreview;
  };
}
