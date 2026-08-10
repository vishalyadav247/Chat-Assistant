// Server-side HTML sanitizer for merchant-authored rich text (FAQ answers,
// starter answers, disclaimers, campaign messages). Allow-list based — no
// dependency; block scripts/styles/handlers/urls that execute.

const ALLOWED_TAGS = new Set([
  "p", "br", "b", "strong", "i", "em", "u", "s",
  "ol", "ul", "li", "a", "img", "h3", "h4", "blockquote", "span",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height"]),
  span: new Set(["style"]),
};

const SAFE_URL = /^(https?:\/\/|\/|mailto:|tel:)/i;
// Only color styling from the FAQ editor's color control.
const SAFE_STYLE = /^color:\s*#[0-9a-fA-F]{3,8};?$/;

export function sanitizeHtml(input: string): string {
  let html = input.slice(0, 20_000);

  // Drop comment/script/style blocks entirely.
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/<(script|style|iframe|object|embed|form|svg|math)[\s\S]*?<\/\1>/gi, "");
  html = html.replace(/<(script|style|iframe|object|embed|form|svg|math)[^>]*\/?>/gi, "");

  // Walk remaining tags.
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g, (whole, rawTag: string, rawAttrs: string, selfClose: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (whole.startsWith("</")) return `</${tag}>`;

    const allowed = ALLOWED_ATTRS[tag];
    let attrs = "";
    if (allowed && rawAttrs) {
      const attrRe = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(rawAttrs))) {
        const name = m[1].toLowerCase();
        const value = (m[3] ?? m[4] ?? "").trim();
        if (!allowed.has(name)) continue;
        if ((name === "href" || name === "src") && !SAFE_URL.test(value)) continue;
        if (name === "style" && !SAFE_STYLE.test(value)) continue;
        if (name === "target" && value !== "_blank") continue;
        attrs += ` ${name}="${value.replace(/"/g, "&quot;")}"`;
      }
      if (tag === "a" && attrs.includes("target=")) attrs += ` rel="noopener noreferrer"`;
    }
    return `<${tag}${attrs}${selfClose ? " /" : ""}>`;
  });

  return html;
}

/** Plain-text strip for search/embedding contexts. */
export function stripToText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
