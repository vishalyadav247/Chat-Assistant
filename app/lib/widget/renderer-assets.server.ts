// eslint-disable-next-line import/no-unresolved -- Vite `?raw` suffix (typed by vite/client)
import rendererJs from "../../../extensions/chat-widget/assets/widget-renderer.js?raw";
// eslint-disable-next-line import/no-unresolved -- Vite `?raw` suffix (typed by vite/client)
import widgetCss from "../../../extensions/chat-widget/assets/chat-widget.css?raw";

// Preview parity seam (spec 06): the admin live preview injects the SAME
// renderer + stylesheet the storefront widget ships (extensions/chat-widget/
// assets). Vite `?raw` inlines the file contents at build time; this module is
// `.server` so the raw strings travel to the client only via loader data —
// same settings JSON in → same DOM out, preview cannot drift from storefront.

export const widgetRendererJs: string = rendererJs;
export const widgetCssText: string = widgetCss;
