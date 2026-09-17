-- AlterTable
ALTER TABLE "sync_states" ADD COLUMN     "articleSyncAt" TIMESTAMP(3),
ADD COLUMN     "pageSyncAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "store_pages" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyPageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL DEFAULT '',
    "bodyText" TEXT NOT NULL DEFAULT '',
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "learnEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_articles" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyArticleId" TEXT NOT NULL,
    "blogTitle" TEXT NOT NULL DEFAULT '',
    "blogHandle" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL DEFAULT '',
    "bodyText" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "author" TEXT NOT NULL DEFAULT '',
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "learnEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blog_articles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_pages_shopId_idx" ON "store_pages"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "store_pages_shopId_shopifyPageId_key" ON "store_pages"("shopId", "shopifyPageId");

-- CreateIndex
CREATE INDEX "blog_articles_shopId_idx" ON "blog_articles"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "blog_articles_shopId_shopifyArticleId_key" ON "blog_articles"("shopId", "shopifyArticleId");

-- Data: Website URL sources are single-page only from spec 22 on. Existing
-- linked/sitemap rows become "page" so a re-sync fetches exactly the URL the
-- merchant typed, which is what the form now promises.
UPDATE "data_sources" SET "crawlScope" = 'page' WHERE "type" = 'url' AND "crawlScope" IS DISTINCT FROM 'page';
