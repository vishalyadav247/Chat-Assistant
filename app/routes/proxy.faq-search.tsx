import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resolveShopId } from "../lib/tenancy.server";
import { sanitizeHtml } from "../lib/sanitize.server";

// GET /apps/ccwidget/faq-search?q=… — server-side FAQ search for the widget
// FAQ screen (spec 05 delta closed 2026-08-10). Searches ALL published FAQs,
// not just the featured set the boot config carries. Shop identity comes ONLY
// from the verified proxy signature; response shape matches
// config.featuredFaqs so the renderer reuses one code path.

const MAX_RESULTS = 10;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return new Response("app not installed", { status: 404 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!q) return Response.json({ faqs: [] });

  const shopId = await resolveShopId(session.shop);
  const [faqs, categories] = await Promise.all([
    db.faq.findMany({
      where: {
        shopId,
        status: "published",
        question: { contains: q, mode: "insensitive" },
      },
      orderBy: [{ featured: "desc" }, { position: "asc" }],
      take: MAX_RESULTS,
      select: { id: true, question: true, answerHtml: true, categoryId: true },
    }),
    db.faqCategory.findMany({ where: { shopId }, select: { id: true, name: true } }),
  ]);

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  return Response.json(
    {
      faqs: faqs.map((f) => ({
        id: f.id,
        question: f.question,
        // Defense in depth: sanitize at serve time like widget-config does.
        answerHtml: sanitizeHtml(f.answerHtml),
        category: (f.categoryId && categoryName.get(f.categoryId)) || null,
      })),
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
};
