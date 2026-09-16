-- Spec 28 — lookup tables: a merchant CSV (vehicle fitment, size charts, spec
-- sheets…) stored row by row so the AI filters it exactly instead of searching
-- text chunks. The owning data_sources row has type 'table'; its metadata holds
-- the column names and roles, rows hold cells keyed "c0", "c1", ….

CREATE TABLE "lookup_rows" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    -- {key: cell as uploaded}
    "values" JSONB NOT NULL,
    -- {key: normalised cell} — lowercase, no diacritics, single spaces
    "norm" JSONB NOT NULL,
    -- {key: [lo, hi]} for cells that are a number or a range "a-b"
    "nums" JSONB NOT NULL,

    CONSTRAINT "lookup_rows_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lookup_rows_shopId_dataSourceId_rowIndex_idx" ON "lookup_rows"("shopId", "dataSourceId", "rowIndex");
CREATE INDEX "lookup_rows_norm_idx" ON "lookup_rows" USING GIN ("norm" jsonb_path_ops);

-- The uploaded file (gzip), read by the import job; deleted with its source.
CREATE TABLE "lookup_files" (
    "dataSourceId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "gzip" BYTEA NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lookup_files_pkey" PRIMARY KEY ("dataSourceId")
);

CREATE INDEX "lookup_files_shopId_idx" ON "lookup_files"("shopId");
