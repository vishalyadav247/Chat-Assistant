/**
 * What product search requires before a product may be shown (the SQL filter
 * in product-search.server.ts), for the paths that look products up BY ID
 * instead — curated cards, recommendation rules, cross-sell companions, the
 * detail lane's named products, and the dashboard's "learned" count (QA-U2).
 * Those used to check stock alone, so a product the merchant switched off, or
 * one that is draft/archived or not on the Online Store, could still be carded
 * — the last two as a link that 404s. One definition, so the counts the
 * merchant sees and what the AI can show never drift.
 */
export const SHOWABLE_PRODUCT = { learnEnabled: true, status: "active", publishedOnline: true } as const;
