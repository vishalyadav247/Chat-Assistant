import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

// Contextual save bar (specs 06/08/16): shows Shopify's save bar when a form
// is dirty; Save submits, Discard resets. Uses the App Bridge saveBar API via
// the ui-save-bar web component pattern.

export function SaveBar(props: {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const shopify = useAppBridge();

  useEffect(() => {
    if (props.dirty) {
      shopify.saveBar?.show?.("chatconvert-save-bar");
    } else {
      shopify.saveBar?.hide?.("chatconvert-save-bar");
    }
  }, [props.dirty, shopify]);

  return (
    <ui-save-bar id="chatconvert-save-bar">
      <button
        variant="primary"
        onClick={props.onSave}
        {...(props.saving ? { loading: "" } : {})}
      ></button>
      <button onClick={props.onDiscard}></button>
    </ui-save-bar>
  );
}
