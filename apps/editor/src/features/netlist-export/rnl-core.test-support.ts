import { readFile } from "node:fs/promises";
import { startCore } from "@rich-netlist/runtime";
import { withCanvasPackage } from "./rnl-core";

const text = readFile(
  new URL(
    import.meta
      .resolve("@rich-netlist/runtime/packages/analog-canvas-extensions.rnl"),
  ),
  "utf8",
);

/** @internal Real Node core with the editor's package workspace, shared by contract tests. */
export async function createRnlTestCore() {
  const packageText = await text;
  return withCanvasPackage(startCore(), packageText);
}
