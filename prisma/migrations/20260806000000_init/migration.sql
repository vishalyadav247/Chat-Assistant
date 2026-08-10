-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "currency" TEXT,
    "timezone" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "planStatus" TEXT NOT NULL DEFAULT 'none',
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "productType" TEXT NOT NULL DEFAULT '',
    "vendor" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "price" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "handle" TEXT NOT NULL DEFAULT '',
    "variants" JSONB,
    "contentHash" TEXT,
    "learnEnabled" BOOLEAN NOT NULL DEFAULT true,
    "embedding" vector(1536),
    "searchText" tsvector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyCollectionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "conditions" TEXT NOT NULL DEFAULT 'Manual',
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "learnEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discounts" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyDiscountId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_states" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productSyncAt" TIMESTAMP(3),
    "collectionSyncAt" TIMESTAMP(3),
    "discountSyncAt" TIMESTAMP(3),
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "errorMessage" TEXT,
    "cappedAt" INTEGER,

    CONSTRAINT "sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sources" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "crawlScope" TEXT,
    "reCrawlWeekly" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "dataSourceId" TEXT,
    "topic" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_categories" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '📄',
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'published',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "faq_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faqs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "categoryId" TEXT,
    "question" TEXT NOT NULL,
    "answerHtml" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "faqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curated_answers" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "synonyms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "talkingPoints" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "servedCount" INTEGER NOT NULL DEFAULT 0,
    "stockIssue" BOOLEAN NOT NULL DEFAULT false,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "curated_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "triggerQuestions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "embedding" vector(1536),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_recommendations" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "searchTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personas" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "communicationStyle" TEXT NOT NULL DEFAULT 'friendly',
    "brandVoice" TEXT NOT NULL DEFAULT '',
    "behaviours" TEXT NOT NULL DEFAULT '',
    "guidelines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avoid" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scope" TEXT NOT NULL DEFAULT '',
    "offTopicMessage" TEXT NOT NULL DEFAULT '',
    "defaultLanguage" TEXT NOT NULL DEFAULT 'en',
    "languages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "autoDetectLanguage" BOOLEAN NOT NULL DEFAULT false,
    "welcomeMessage" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "personas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardrails" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "answerOnlyFromKnowledge" BOOLEAN NOT NULL DEFAULT true,
    "bannedTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fallbackMessage" TEXT NOT NULL DEFAULT '',
    "minMeaningScore" DOUBLE PRECISION NOT NULL DEFAULT 0.30,
    "curatedMatchThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.80,
    "curatedBorderline" DOUBLE PRECISION NOT NULL DEFAULT 0.65,
    "bannedMatchThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.35,

    CONSTRAINT "guardrails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_configs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "config" JSONB NOT NULL,

    CONSTRAINT "handover_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_settings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "settings" JSONB NOT NULL,

    CONSTRAINT "widget_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_settings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "settings" JSONB NOT NULL,

    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "contactId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'ai',
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "unread" BOOLEAN NOT NULL DEFAULT true,
    "handover" BOOLEAN NOT NULL DEFAULT false,
    "assigneeId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'store',
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT,
    "rating" INTEGER,
    "pageContext" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "author" TEXT NOT NULL DEFAULT 'ai',
    "content" TEXT NOT NULL,
    "productCards" JSONB,
    "sourceLayer" TEXT,
    "intent" JSONB,
    "seenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sessionId" TEXT,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "type" TEXT NOT NULL DEFAULT 'anonymous',
    "channel" TEXT NOT NULL DEFAULT 'store',
    "location" TEXT,
    "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "shopifyCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_daily" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "counters" JSONB NOT NULL,

    CONSTRAINT "metrics_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB,
    "views" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "atcs" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_usage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "conversationCount" INTEGER NOT NULL DEFAULT 0,
    "overageCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "plan_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_requests" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "exportPath" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redact_logs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "redact_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_domain_key" ON "shops"("domain");

-- CreateIndex
CREATE INDEX "products_shopId_price_idx" ON "products"("shopId", "price");

-- CreateIndex
CREATE INDEX "products_shopId_stock_idx" ON "products"("shopId", "stock");

-- CreateIndex
CREATE UNIQUE INDEX "products_shopId_shopifyProductId_key" ON "products"("shopId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "collections_shopId_idx" ON "collections"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "collections_shopId_shopifyCollectionId_key" ON "collections"("shopId", "shopifyCollectionId");

-- CreateIndex
CREATE INDEX "discounts_shopId_idx" ON "discounts"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "discounts_shopId_shopifyDiscountId_key" ON "discounts"("shopId", "shopifyDiscountId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_states_shopId_key" ON "sync_states"("shopId");

-- CreateIndex
CREATE INDEX "data_sources_shopId_type_idx" ON "data_sources"("shopId", "type");

-- CreateIndex
CREATE INDEX "knowledge_shopId_idx" ON "knowledge"("shopId");

-- CreateIndex
CREATE INDEX "knowledge_dataSourceId_idx" ON "knowledge"("dataSourceId");

-- CreateIndex
CREATE INDEX "faq_categories_shopId_idx" ON "faq_categories"("shopId");

-- CreateIndex
CREATE INDEX "faqs_shopId_status_idx" ON "faqs"("shopId", "status");

-- CreateIndex
CREATE INDEX "curated_answers_shopId_status_idx" ON "curated_answers"("shopId", "status");

-- CreateIndex
CREATE INDEX "recommendations_shopId_idx" ON "recommendations"("shopId");

-- CreateIndex
CREATE INDEX "custom_recommendations_shopId_idx" ON "custom_recommendations"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "personas_shopId_key" ON "personas"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "guardrails_shopId_key" ON "guardrails"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "handover_configs_shopId_key" ON "handover_configs"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "widget_settings_shopId_key" ON "widget_settings"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "shop_settings_shopId_key" ON "shop_settings"("shopId");

-- CreateIndex
CREATE INDEX "conversations_shopId_status_lastMessageAt_idx" ON "conversations"("shopId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "conversations_shopId_sessionId_idx" ON "conversations"("shopId", "sessionId");

-- CreateIndex
CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "messages_shopId_idx" ON "messages"("shopId");

-- CreateIndex
CREATE INDEX "contacts_shopId_email_idx" ON "contacts"("shopId", "email");

-- CreateIndex
CREATE INDEX "contacts_shopId_type_idx" ON "contacts"("shopId", "type");

-- CreateIndex
CREATE INDEX "analytics_events_shopId_type_occurredAt_idx" ON "analytics_events"("shopId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "metrics_daily_shopId_date_key" ON "metrics_daily"("shopId", "date");

-- CreateIndex
CREATE INDEX "campaigns_shopId_priority_idx" ON "campaigns"("shopId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "plan_usage_shopId_periodStart_key" ON "plan_usage"("shopId", "periodStart");

-- CreateIndex
CREATE INDEX "data_requests_shopId_idx" ON "data_requests"("shopId");

-- CreateIndex
CREATE INDEX "redact_logs_shopId_idx" ON "redact_logs"("shopId");


-- ── Custom SQL (hand-written; Prisma's differ ignores Unsupported-column changes) ──

-- searchText becomes a GENERATED tsvector column (Prisma created it as a plain column)
ALTER TABLE "products" DROP COLUMN "searchText";
ALTER TABLE "products" ADD COLUMN "searchText" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("title",'') || ' ' || coalesce("description",''))) STORED;

-- Vector similarity indexes (HNSW, cosine)
CREATE INDEX "products_embedding_hnsw" ON "products" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "knowledge_embedding_hnsw" ON "knowledge" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "curated_answers_embedding_hnsw" ON "curated_answers" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "recommendations_embedding_hnsw" ON "recommendations" USING hnsw ("embedding" vector_cosine_ops);

-- Full-text index for keyword search
CREATE INDEX "products_search_text_gin" ON "products" USING GIN ("searchText");
