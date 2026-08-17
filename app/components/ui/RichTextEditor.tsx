import { useCallback, useEffect, useRef, useState } from "react";
import { INK, RADIUS, SPACE } from "./tokens";

// Minimal rich-text editor in the style of the Shopify admin's description
// editor (toolbar: bold / italic / underline / lists / link). Polaris web
// components ship no rich-text field, so this is a contentEditable surface
// whose HTML value is sanitized SERVER-SIDE on save (lib/sanitize.server.ts
// allow-list) — the editor only needs to produce reasonable markup.
//
// Controlled by value/onChange, but the DOM is only re-synced from `value`
// when it differs from what the editor last emitted (otherwise every
// keystroke would reset the caret).

type Cmd = "bold" | "italic" | "underline" | "insertUnorderedList" | "insertOrderedList";

const BTN: React.CSSProperties = {
  width: 28,
  height: 28,
  border: "none",
  borderRadius: 6,
  background: "transparent",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: INK.strong,
  padding: 0,
};

const ICON = {
  bold: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M6 3.5h5a3.5 3.5 0 0 1 2.4 6.05A3.75 3.75 0 0 1 11.75 16.5H6V3.5Zm2.5 2.25v3h2.5a1.5 1.5 0 0 0 0-3H8.5Zm0 5.25v3.25h3.25a1.625 1.625 0 0 0 0-3.25H8.5Z" />
    </svg>
  ),
  italic: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M8 3.5h7v2h-2.6l-2.8 9h2.4v2H5v-2h2.6l2.8-9H8v-2Z" />
    </svg>
  ),
  underline: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M6 3.5h2v6.25a2 2 0 1 0 4 0V3.5h2v6.25a4 4 0 0 1-8 0V3.5ZM5 15.5h10v1.5H5v-1.5Z" />
    </svg>
  ),
  ul: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <circle cx="4.5" cy="5.5" r="1.5" />
      <circle cx="4.5" cy="10" r="1.5" />
      <circle cx="4.5" cy="14.5" r="1.5" />
      <path d="M8 4.75h8.5v1.5H8v-1.5Zm0 4.5h8.5v1.5H8v-1.5Zm0 4.5h8.5v1.5H8v-1.5Z" />
    </svg>
  ),
  ol: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M3.4 7V4.6h-.9V3.8l1.9-.4V7h-1Zm-.9 5.2v-.9l1.7-1.7c.2-.2.3-.4.3-.6 0-.3-.2-.5-.5-.5s-.5.2-.6.5l-.9-.3c.2-.7.8-1.1 1.6-1.1.9 0 1.5.5 1.5 1.3 0 .5-.2.9-.6 1.3l-.9.9h1.6v1H2.5Zm.1 4.9v-.9h1.5c.3 0 .5-.1.5-.4s-.2-.4-.5-.4h-.6v-.8h.6c.3 0 .4-.1.4-.3s-.2-.4-.4-.4H2.7v-.9h1.6c.9 0 1.4.4 1.4 1.1 0 .4-.2.7-.5.9.4.1.7.5.7 1 0 .7-.6 1.1-1.5 1.1H2.6Z" />
      <path d="M8 4.75h8.5v1.5H8v-1.5Zm0 4.5h8.5v1.5H8v-1.5Zm0 4.5h8.5v1.5H8v-1.5Z" />
    </svg>
  ),
  link: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M8.5 11.5a3.5 3.5 0 0 0 4.95 0l2.05-2.05a3.5 3.5 0 0 0-4.95-4.95L9.4 5.65" strokeLinecap="round" />
      <path d="M11.5 8.5a3.5 3.5 0 0 0-4.95 0L4.5 10.55a3.5 3.5 0 0 0 4.95 4.95l1.15-1.15" strokeLinecap="round" />
    </svg>
  ),
};

/** Plain-text length of an HTML string (for character counters). */
export function htmlTextLength(html: string): number {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").length;
}

export function RichTextEditor(props: {
  label: string;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Approximate rows for the editing area's min-height. */
  rows?: number;
  /** Shown under the field (e.g. a character counter). */
  details?: React.ReactNode;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string>("");
  const savedRange = useRef<Range | null>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [focused, setFocused] = useState(false);

  // Sync DOM ← value only when the value changed from outside.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (props.value !== lastEmitted.current) {
      el.innerHTML = props.value || "";
      lastEmitted.current = props.value || "";
    }
  }, [props.value]);

  const emit = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    // An "empty" editor still holds a stray <br> — normalize to "".
    const html = /^(<br\s*\/?>|\s|&nbsp;)*$/i.test(el.innerHTML) ? "" : el.innerHTML;
    lastEmitted.current = html;
    props.onChange(html);
  }, [props]);

  const refreshActive = useCallback(() => {
    const el = editorRef.current;
    const sel = document.getSelection();
    if (!el || !sel || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
    const next: Record<string, boolean> = {};
    for (const cmd of ["bold", "italic", "underline", "insertUnorderedList", "insertOrderedList"]) {
      try {
        next[cmd] = document.queryCommandState(cmd);
      } catch {
        next[cmd] = false;
      }
    }
    let node: Node | null = sel.anchorNode;
    while (node && node !== el) {
      if (node instanceof HTMLAnchorElement) {
        next.link = true;
        break;
      }
      node = node.parentNode;
    }
    setActive(next);
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshActive);
    return () => document.removeEventListener("selectionchange", refreshActive);
  }, [refreshActive]);

  const exec = (cmd: Cmd) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false);
    emit();
    refreshActive();
  };

  const saveSelection = () => {
    const sel = document.getSelection();
    const el = editorRef.current;
    if (sel && sel.rangeCount > 0 && el && el.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    } else {
      savedRange.current = null;
    }
  };

  const restoreSelection = () => {
    const sel = document.getSelection();
    if (!sel || !savedRange.current) return;
    sel.removeAllRanges();
    sel.addRange(savedRange.current);
  };

  const openLink = () => {
    saveSelection();
    // Pre-fill with the href when the caret sits inside an existing link.
    let href = "";
    let node: Node | null = document.getSelection()?.anchorNode ?? null;
    while (node && node !== editorRef.current) {
      if (node instanceof HTMLAnchorElement) {
        href = node.getAttribute("href") ?? "";
        break;
      }
      node = node.parentNode;
    }
    setLinkUrl(href);
    setLinkOpen(true);
  };

  const applyLink = () => {
    const el = editorRef.current;
    if (!el) return;
    let url = linkUrl.trim();
    if (!url) {
      setLinkOpen(false);
      return;
    }
    if (!/^(https?:\/\/|mailto:|tel:|\/)/i.test(url)) url = `https://${url}`;
    el.focus();
    restoreSelection();
    const sel = document.getSelection();
    // Editing an existing link: just update its href (re-wrapping would nest).
    let node: Node | null = sel?.anchorNode ?? null;
    while (node && node !== el) {
      if (node instanceof HTMLAnchorElement) {
        node.setAttribute("href", url);
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
        setLinkOpen(false);
        emit();
        refreshActive();
        return;
      }
      node = node.parentNode;
    }
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      // Nothing selected → insert the URL itself as the link text.
      const safe = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      document.execCommand("insertHTML", false, `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`);
    } else {
      document.execCommand("createLink", false, url);
      // Storefront links should leave the chat in a new tab.
      el.querySelectorAll("a").forEach((a) => {
        if (a.getAttribute("href") === url) {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
        }
      });
    }
    setLinkOpen(false);
    emit();
    refreshActive();
  };

  const removeLink = () => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    restoreSelection();
    document.execCommand("unlink", false);
    // Collapsed caret inside a link: unlink needs a selection — expand to it.
    let node: Node | null = document.getSelection()?.anchorNode ?? null;
    while (node && node !== el) {
      if (node instanceof HTMLAnchorElement) {
        const text = document.createTextNode(node.textContent ?? "");
        node.replaceWith(text);
        break;
      }
      node = node.parentNode;
    }
    setLinkOpen(false);
    emit();
    refreshActive();
  };

  const toolButton = (label: string, cmdKey: string, icon: React.ReactNode, onClick: () => void) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={Boolean(active[cmdKey])}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection
      onClick={onClick}
      style={{
        ...BTN,
        background: active[cmdKey] ? "var(--s-color-bg-surface-selected, #e5e5ea)" : "transparent",
      }}
    >
      {icon}
    </button>
  );

  const rows = props.rows ?? 5;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.xs }}>
      <s-text>{props.label}</s-text>
      <div
        style={{
          border: `1px solid ${focused ? "var(--s-color-border-emphasis, #303030)" : "var(--s-color-border, #8a8a8f)"}`,
          borderRadius: RADIUS.chip,
          background: "var(--s-color-bg-surface, #fff)",
          overflow: "hidden",
          boxShadow: focused ? "0 0 0 1px var(--s-color-border-emphasis, #303030)" : undefined,
        }}
      >
        <div
          role="toolbar"
          aria-label={`${props.label} formatting`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            padding: "4px 6px",
            borderBottom: `1px solid ${INK.border}`,
            background: INK.surface2,
            flexWrap: "wrap",
          }}
        >
          {toolButton("Bold", "bold", ICON.bold, () => exec("bold"))}
          {toolButton("Italic", "italic", ICON.italic, () => exec("italic"))}
          {toolButton("Underline", "underline", ICON.underline, () => exec("underline"))}
          <span style={{ width: 1, height: 18, background: INK.border, margin: "0 4px" }} />
          {toolButton("Bulleted list", "insertUnorderedList", ICON.ul, () => exec("insertUnorderedList"))}
          {toolButton("Numbered list", "insertOrderedList", ICON.ol, () => exec("insertOrderedList"))}
          <span style={{ width: 1, height: 18, background: INK.border, margin: "0 4px" }} />
          {toolButton("Insert link", "link", ICON.link, openLink)}
        </div>

        {linkOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault(); // Enter in the URL field applies the link
              applyLink();
            }}
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: SPACE.sm,
              padding: "8px 10px",
              borderBottom: `1px solid ${INK.border}`,
              background: INK.surface2,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <s-text-field
                label="Link URL"
                placeholder="https://example.com/page"
                value={linkUrl}
                onInput={(e) => setLinkUrl(e.currentTarget.value)}
              />
            </div>
            <s-button variant="primary" onClick={applyLink} disabled={!linkUrl.trim()}>
              Apply
            </s-button>
            {active.link ? (
              <s-button tone="critical" onClick={removeLink}>
                Remove
              </s-button>
            ) : null}
            <s-button variant="tertiary" onClick={() => setLinkOpen(false)}>
              Cancel
            </s-button>
          </form>
        ) : null}

        <div style={{ position: "relative" }}>
          {!props.value && !focused && props.placeholder ? (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 12,
                top: 10,
                color: INK.faint,
                pointerEvents: "none",
                fontSize: 13,
              }}
            >
              {props.placeholder}
            </span>
          ) : null}
          <div
            ref={editorRef}
            className="cc-rte"
            contentEditable
            suppressContentEditableWarning
            tabIndex={0}
            role="textbox"
            aria-multiline="true"
            aria-label={props.label}
            onInput={emit}
            onBlur={() => {
              setFocused(false);
              emit();
            }}
            onFocus={() => setFocused(true)}
            onKeyUp={refreshActive}
            onMouseUp={refreshActive}
            onClick={(e) => {
              // Links must never navigate from inside the editor — clicking one
              // selects it and opens the URL row for editing instead.
              const anchor = (e.target as HTMLElement).closest?.("a");
              if (!anchor || !editorRef.current?.contains(anchor)) return;
              e.preventDefault();
              const range = document.createRange();
              range.selectNodeContents(anchor);
              const sel = document.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
              savedRange.current = range.cloneRange();
              setLinkUrl(anchor.getAttribute("href") ?? "");
              setLinkOpen(true);
              refreshActive();
            }}
            onAuxClick={(e) => {
              // Middle-click would open the link in a new tab.
              if ((e.target as HTMLElement).closest?.("a")) e.preventDefault();
            }}
            onPaste={(e) => {
              // Paste as plain text — keeps foreign markup out of the answer.
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain");
              document.execCommand("insertText", false, text);
            }}
            style={{
              minHeight: rows * 22 + 20,
              padding: "10px 12px",
              fontSize: 13,
              lineHeight: "22px",
              outline: "none",
              color: INK.strong,
              overflowWrap: "anywhere",
            }}
          />
        </div>
      </div>
      <style>{`
        .cc-rte a { color: #005bd3; text-decoration: underline; }
        .cc-rte ul, .cc-rte ol { margin: 0 0 0 20px; padding: 0; }
        .cc-rte p { margin: 0; }
      `}</style>
      {props.details ? (
        <span style={{ fontSize: 12, color: INK.muted }}>{props.details}</span>
      ) : null}
    </div>
  );
}
