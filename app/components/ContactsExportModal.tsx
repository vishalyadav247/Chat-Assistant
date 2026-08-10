import { useState } from "react";
import { BrowseModalShell } from "./BrowseProductsModal";

// Export contacts modal (design contacts.html #mExport): radio Current page /
// All contacts, Cancel / Export. Controlled overlay; the route runs the export
// action and turns the returned CSV into a client-side download.

export type ExportScope = "page" | "all";

export function ContactsExportModal(props: {
  open: boolean;
  exporting: boolean;
  onClose: () => void;
  onExport: (scope: ExportScope) => void;
}) {
  const [scope, setScope] = useState<ExportScope>("page");

  return (
    <BrowseModalShell
      open={props.open}
      title="Export contacts"
      onClose={props.onClose}
      footer={
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", width: "100%" }}>
          <s-button onClick={props.onClose}>Cancel</s-button>
          <s-button
            variant="primary"
            disabled={props.exporting}
            onClick={() => props.onExport(scope)}
          >
            {props.exporting ? "Exporting…" : "Export"}
          </s-button>
        </div>
      }
    >
      <s-stack gap="small">
        <s-choice-list
          name="export-scope"
          label="Select contacts to export"
          values={[scope]}
          onChange={(e) => {
            const selected = e.currentTarget.values?.[0];
            setScope(selected === "all" ? "all" : "page");
          }}
        >
          <s-choice value="page">Current page</s-choice>
          <s-choice value="all">All contacts</s-choice>
        </s-choice-list>
      </s-stack>
    </BrowseModalShell>
  );
}
