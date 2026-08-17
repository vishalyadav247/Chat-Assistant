import { useEffect, useRef } from "react";
import type { ChangeEvent } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

// Shared image-upload button for the chatbox page (header logo + custom
// launcher icon). Submits multipart to the chatbox action; the server
// (uploadImage) enforces ≤2MB and SVG/PNG/JPG/WebP and returns a CDN URL that
// the caller places into the draft settings (never data URLs — spec 06).

interface UploadResult {
  ok: boolean;
  intent: string;
  error?: string;
  url?: string;
}

export function ChatboxUploadButton(props: {
  intent: "upload-logo" | "upload-icon";
  label: string;
  /** MIME allowlist for the file picker; the server re-validates per intent. */
  accept?: string;
  onUploaded: (url: string) => void;
  /** Custom trigger instead of the default upload button (e.g. a placeholder
   *  box that opens the picker). Receives the opener + in-flight state. */
  renderTrigger?: (open: () => void, uploading: boolean) => React.ReactNode;
}) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<UploadResult>();
  const fileRef = useRef<HTMLInputElement>(null);
  const handled = useRef<UploadResult | undefined>(undefined);
  const uploading = fetcher.state !== "idle";

  const { onUploaded } = props;
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok && fetcher.data.url) {
      onUploaded(fetcher.data.url);
      shopify.toast.show("Image uploaded");
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.state, fetcher.data, onUploaded, shopify]);

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.set("intent", props.intent);
    fd.set("file", file);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
    event.currentTarget.value = "";
  };

  return (
    <>
      {props.renderTrigger ? (
        props.renderTrigger(() => fileRef.current?.click(), uploading)
      ) : (
        <s-button icon="upload" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? "Uploading…" : props.label}
        </s-button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept={props.accept ?? "image/png,image/jpeg,image/webp,image/svg+xml"}
        style={{ display: "none" }}
        aria-label={props.label}
        onChange={onFile}
      />
    </>
  );
}
