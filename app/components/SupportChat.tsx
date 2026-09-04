// Progryss' own support widget — the "talk to support" bubble merchants see at
// the bottom-right of the embedded app.
//
// Mounted ONLY on the embedded admin surface (app/routes/app.tsx), never from
// root.tsx: the operator console (/admin) is our own team, the standalone web
// surface (/web) is the merchant's agents working the inbox, and the storefront
// carries the merchant's OWN chat widget. A support bubble on any of those is
// either noise or actively confusing.
//
// Rendered as ordinary markup rather than injected from an effect so the
// browser parses it as a normal script: the loader reads
// `document.currentScript.dataset.appId` to know which workspace to boot.
export function SupportChat() {
  return (
    <script
      src="https://chat.progryss.com/widget/v1.js"
      data-app-id="chatconvert-live"
      async
    />
  );
}
