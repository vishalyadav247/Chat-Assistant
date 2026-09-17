/* Spec 28 — lookup tables. Run: npx tsx scripts/qa/lookup-tables.test.ts
 *
 * Direct module calls against the dev database on two throwaway shops (no
 * server, no queue worker, no LLM). Builds a 200,000-row vehicle-fitment CSV,
 * imports it on Plus, and checks limits, matching, narrowing, product links,
 * edits, tenancy and cleanup. cleanupShop runs in `finally`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

for (const line of readFileSync(join(process.cwd(), ".env"), "utf-8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith("#") && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.SHOPIFY_API_KEY ||= "qa-placeholder-key";
process.env.SHOPIFY_API_SECRET ||= "qa-placeholder-secret";
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SCOPES ||= "read_products";

const SHOP_A = "qa-lookup-a.myshopify.com";
const SHOP_B = "qa-lookup-b.myshopify.com";

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) passed++;
  else failed++;
  console[condition ? "log" : "error"](`  ${condition ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const MAKES: Record<string, string[]> = {
  Honda: ["Civic", "Civic Hatchback", "Accord", "CR-V", "Jazz"],
  Toyota: ["Corolla", "Camry", "RAV4", "Hilux", "Yaris"],
  Ford: ["F-150", "Focus", "Fiesta", "Ranger", "Mustang"],
  "Mercedes-Benz": ["C-Class", "E-Class", "Sprinter", "GLA", "A-Class"],
  Volkswagen: ["Golf", "Polo", "Passat", "Tiguan", "Jetta"],
  Hyundai: ["i20", "Creta", "Tucson", "Elantra", "Verna"],
  "Maruti Suzuki": ["Swift", "Baleno", "Dzire", "Ertiga", "Brezza"],
  Nissan: ["Micra", "Qashqai", "Navara", "Altima", "Sunny"],
};
const ENGINES = ["1.2L Petrol", "1.5L Petrol", "1.8L Petrol", "2.0L Diesel"];
const PARTS = ["Brake Pads", "Brake Discs", "Air Filter", "Oil Filter", "Spark Plugs", "Wiper Blades"];
const POSITIONS = ["Front", "Rear"];
const BRANDS = ["Bosch", "Brembo", "Denso", "Valeo"];

/** Unique fitment rows: brand × year × make × model × engine × part × position (1,920 per brand-year). */
function fitmentCsv(rows: number): string {
  const lines = ["Make,Model,Year,Engine,Part Type,Position,Brand,SKU,Notes"];
  let n = 0;
  outer: for (const brand of BRANDS) {
    for (let y = 1995; y <= 2024; y++) {
      for (const [make, models] of Object.entries(MAKES)) {
        for (const model of models) {
          for (const engine of ENGINES) {
            for (const part of PARTS) {
              for (const position of POSITIONS) {
                const sku = `${brand.slice(0, 2).toUpperCase()}-${make.slice(0, 3).toUpperCase()}-${model.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}-${y}-${ENGINES.indexOf(engine)}-${PARTS.indexOf(part)}${position[0]}`;
                lines.push(`${make},"${model}",${y},${engine},${part},${position},${brand},${sku},"Fits ${make} ${model}, ${engine}"`);
                if (++n >= rows) break outer;
              }
            }
          }
        }
      }
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const db = (await import("../../app/db.server")).default;
  const { cleanupShop } = await import("../../app/lib/jobs/handlers.server");
  const lookup = await import("../../app/lib/lookup/lookup-import.server");
  const search = await import("../../app/lib/lookup/lookup-search.server");
  const shared = await import("../../app/lib/lookup/lookup-shared");
  const { ingestSource } = await import("../../app/lib/ingestion/knowledge-ingest.server");
  const { deleteSource, createSource, QuotaError } = await import("../../app/lib/ingestion/sources.server");
  const { getQuota, loadPlanConfig } = await import("../../app/lib/billing/plans.server");
  await loadPlanConfig();

  const resetShops = async () => {
    for (const d of [SHOP_A, SHOP_B]) {
      await cleanupShop(d).catch(() => undefined);
      await db.shop.deleteMany({ where: { domain: d } });
    }
  };
  await resetShops();
  const A = (await db.shop.create({ data: { domain: SHOP_A, plan: "pro" } })).id;
  const B = (await db.shop.create({ data: { domain: SHOP_B, plan: "plus" } })).id;

  try {
    console.log("\n── Shared helpers");
    ok("LT1 normalise: case, accents, spaces", shared.normalizeCell("  Škoda   OCTAVIA ") === "skoda octavia");
    ok("LT2 compact: F-150 = f150", shared.compactCell("F-150") === shared.compactCell("f150"));
    ok(
      "LT3 number ranges",
      JSON.stringify(shared.parseNumberRange("2016-2012")) === "[2012,2016]" &&
        JSON.stringify(shared.parseNumberRange("1,200")) === "[1200,1200]" &&
        shared.parseNumberRange("1.8L") === null,
    );
    ok("LT4 delimiter detection", shared.detectDelimiter("a;b;c\n1;2;3") === ";" && shared.detectDelimiter("a\tb\n") === "\t");
    const BOM = String.fromCharCode(0xfeff);
    const quoted = [...shared.iterateCsv(`${BOM}a,b\n"x, ""y""",2\n\n"multi\nline",3\n`)];
    ok("LT5 CSV quotes, escapes, newlines, BOM, blank lines", quoted.length === 3 && quoted[1][0] === 'x, "y"' && quoted[2][0] === "multi\nline");
    const ranges = shared.detectRanges([
      { key: "c0", name: "Make" },
      { key: "c1", name: "Year From" },
      { key: "c2", name: "Year To" },
      { key: "c3", name: "Start Width" },
      { key: "c4", name: "End Width" },
    ]);
    ok("LT6 range pairs detected", ranges.length === 2 && ranges[0].name === "Year" && ranges[1].name === "Width", JSON.stringify(ranges));
    const sample = [...shared.iterateCsv(fitmentCsv(300))];
    const guessed = shared.guessRoles(sample[0], sample.slice(1));
    ok(
      "LT7 role guess: fitment columns filter, SKU links, notes shown",
      guessed.join() === "filter,filter,filter,filter,filter,filter,filter,link_sku,info",
      guessed.join(),
    );
    // Generic, not vehicle-specific: headers with no known vocabulary are
    // judged from their data alone.
    const paint = [...shared.iterateCsv(
      [
        "Shade,Finish,Coverage,Room,Description,SKU",
        ...Array.from({ length: 60 }, (_, i) =>
          `${["Ivory", "Slate", "Sage", "Coral"][i % 4]},${["Matt", "Silk", "Gloss"][i % 3]},${10 + (i % 5)},${["Kitchen", "Bathroom", "Bedroom"][i % 3]},"A long-lasting washable finish that suits busy rooms and hides marks well",PNT-${i}`,
        ),
      ].join("\n"),
    )];
    const paintRoles = shared.guessRoles(paint[0], paint.slice(1));
    ok("LT7b role guess works for any table (no domain vocabulary)", paintRoles.join() === "filter,filter,filter,filter,info,link_sku", paintRoles.join());
    ok("LT8 mapping needs a filter and one link", shared.mappingProblem(["info", "ignore"]) !== null && shared.mappingProblem(["filter", "link_sku", "link_handle"]) !== null && shared.mappingProblem(["filter", "link_sku"]) === null);

    console.log("\n── Upload limits");
    const big = fitmentCsv(200_000);
    const bigGzip = gzipSync(Buffer.from(big));
    const roles = guessed;
    const upload = (shopId: string, bytes: Buffer, gzipped = true, extra: Partial<Parameters<typeof lookup.createTableSource>[1]> = {}) =>
      lookup.createTableSource(
        shopId,
        { title: "Vehicle fitment", description: "Which parts fit which vehicle", filename: "fitment.csv", roles, bytes, gzipped, ...extra },
        { enqueue: false },
      );
    console.log(`  (fitment CSV: ${(big.length / 1048576).toFixed(1)}MB raw, ${(bigGzip.length / 1048576).toFixed(1)}MB gzip)`);
    const refused = await upload(A, bigGzip).catch((e) => e);
    ok(
      "LT9 Pro (50,000 rows): a 200,000-row file is refused, nothing stored",
      refused instanceof lookup.TableUploadError && /200,000 rows/.test(refused.message) && (await db.dataSource.count({ where: { shopId: A } })) === 0 && (await db.lookupFile.count({ where: { shopId: A } })) === 0,
      refused?.message,
    );
    const headerOnly = await upload(A, Buffer.from("Make,Model\n"), false).catch((e) => e);
    ok("LT10 header-only CSV refused", headerOnly instanceof lookup.TableUploadError);
    const wide = await upload(A, Buffer.from(`${Array.from({ length: 61 }, (_, i) => `c${i}`).join(",")}\n${"1,".repeat(60)}1`), false).catch((e) => e);
    ok("LT11 more than 60 columns refused", wide instanceof lookup.TableUploadError && /61 columns/.test(wide.message));
    const mismatch = await upload(A, Buffer.from("Make,Model\nHonda,Civic\n"), false).catch((e) => e);
    ok("LT12 roles that don't match the header are refused", mismatch instanceof lookup.TableUploadError);
    const noDesc = await upload(A, Buffer.from("Make\nHonda\n"), false, { roles: ["filter"], description: " " }).catch((e) => e);
    ok("LT13 description required", noDesc instanceof lookup.TableUploadError);

    console.log("\n── 200,000-row import on Plus");
    let t0 = Date.now();
    const table = await upload(B, bigGzip);
    const uploadMs = Date.now() - t0;
    ok("LT14 upload stores a pending table counted against lookup_rows", table.status === "pending" && table.chunkCount === 200_000 && (await lookup.lookupRowsUsed(B)) === 200_000, `${uploadMs}ms`);
    // The live Plus limit (an operator may have raised it in /admin/plans).
    const plusRows = getQuota("plus", "lookup_rows");
    const second = await upload(B, gzipSync(Buffer.from(fitmentCsv(10))), true).catch((e) => e);
    ok(
      "LT15 the pending table counts: a second upload is refused exactly when both together pass the limit",
      (second instanceof lookup.TableUploadError) === 200_010 > plusRows,
      `limit=${plusRows} refused=${second instanceof lookup.TableUploadError}`,
    );
    if (!(second instanceof Error)) await deleteSource(B, second.id);
    t0 = Date.now();
    const imported = await ingestSource(B, table.id);
    const importMs = Date.now() - t0;
    const after = await db.dataSource.findFirst({ where: { id: table.id, shopId: B } });
    const meta = lookup.tableMetadata(after?.metadata);
    ok(
      "LT16 ingestSource imports all rows and marks the table active",
      imported.chunkCount === 200_000 && after?.status === "active" && (await db.lookupRow.count({ where: { shopId: B, dataSourceId: table.id } })) === 200_000,
      `${importMs}ms`,
    );
    const year = meta.columns.find((c) => c.name === "Year");
    const make = meta.columns.find((c) => c.name === "Make");
    ok("LT17 column profile: Year numeric, Make 8 values with samples", year?.numeric === true && make?.distinct === 8 && make.samples.length === 8 && make.numeric === false);

    console.log("\n── Matching");
    const tables = await search.activeLookupTables(B);
    ok("LT18 active table listed for the agent", tables.length === 1 && tables[0].name === "Vehicle fitment");
    const q = (filters: Array<[string, string]>) =>
      search.lookupTableRows(B, "Vehicle fitment", filters.map(([column, value]) => ({ column, value })), { tables });
    t0 = Date.now();
    const broad = await q([["Make", "honda"], ["Model", "civic"], ["Year", "2015"]]);
    const broadMs = Date.now() - t0;
    ok(
      "LT19 make/model/year (case-insensitive): exact 'Civic' only, narrow_by engine + part",
      typeof broad.matched_rows === "number" && broad.matched_rows > 1 && broad.rows.every((r) => r.Model === "Civic" && r.Year === "2015") &&
        Boolean(broad.narrow_by?.Engine?.length === 4) && Boolean(broad.narrow_by?.["Part Type"]) && /ask/.test(broad.note ?? ""),
      `${broad.matched_rows} rows, ${broadMs}ms first call`,
    );
    t0 = Date.now();
    await q([["Make", "Honda"], ["Model", "Accord"], ["Year", "2010"]]);
    ok("LT20 repeat lookup is fast (distinct values cached)", Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
    const typo = await q([["Make", "Hondda"], ["Model", "Accord"], ["Year", "2001"], ["Engine", "1.8"], ["Part Type", "brake pads"], ["Position", "front"], ["Brand", "bosch"]]);
    ok("LT21 typo + word prefix ('1.8' → '1.8L Petrol'): one exact row", typo.matched_rows === 1 && typo.rows[0].SKU === "BO-HON-ACCORD-2001-2-0F", JSON.stringify(typo.rows[0]));
    const f150 = await q([["Make", "ford"], ["Model", "F150"], ["Year", "2020"]]);
    ok("LT22 punctuation-insensitive: F150 = F-150", typeof f150.matched_rows === "number" && f150.matched_rows > 0 && f150.rows[0].Model === "F-150");
    const hatch = await q([["Model", "civic hatch"], ["Year", "2015"]]);
    ok("LT23 word prefix: 'civic hatch' → Civic Hatchback", hatch.rows.length > 0 && hatch.rows.every((r) => r.Model === "Civic Hatchback"));
    const unknown = await q([["Make", "Tesla"], ["Model", "Civic"]]);
    ok("LT24 unknown value reported, no rows, no guess", unknown.matched_rows === 0 && unknown.unmatched?.[0]?.column === "Make" && unknown.rows.length === 0);
    const closest = await q([["Model", "Corola xx"]]);
    ok("LT25 near miss offers closest values", (closest.unmatched?.[0]?.closest_values ?? []).includes("corolla") || closest.matched_rows !== 0, JSON.stringify(closest.unmatched));
    const noYear = await q([["Make", "Toyota"], ["Model", "Corolla"], ["Year", "1990"]]);
    ok("LT26 no rows for all filters together → count 0 with a note", noYear.matched_rows === 0 && /No rows/.test(noYear.note ?? ""));
    const many = await q([["Make", "Toyota"]]);
    ok("LT27 count caps at 1000, ≤ 20 rows returned", many.matched_rows === "more than 1000" && many.rows.length === 20);
    const unknownColumn = await q([["Colour", "red"], ["Make", "Nissan"], ["Model", "Micra"], ["Year", "2000"]]);
    ok("LT28 unknown column ignored and reported", (unknownColumn.ignored_filters ?? []).includes("Colour") && typeof unknownColumn.matched_rows === "number" && unknownColumn.matched_rows > 0);

    console.log("\n── Product links");
    const linkedSku = "BR-HON-CIVIC-2015-2-0F";
    await db.product.create({
      data: {
        shopId: B,
        shopifyProductId: "gid://shopify/Product/990001",
        title: "Ceramic Brake Pads — Honda Civic 2012-2016",
        status: "active",
        publishedOnline: true,
        variants: [{ id: "gid://shopify/ProductVariant/1", title: "Front", price: 49, available: true, sku: linkedSku.toLowerCase() }],
      },
    });
    await db.product.create({
      data: {
        shopId: B,
        shopifyProductId: "gid://shopify/Product/990002",
        title: "Draft pads",
        status: "draft",
        variants: [{ id: "gid://shopify/ProductVariant/2", title: "Rear", price: 49, available: true, sku: "BR-HON-CIVIC-2015-2-0R" }],
      },
    });
    const exact = await q([["Make", "Honda"], ["Model", "Civic"], ["Year", "2015"], ["Engine", "1.8L Petrol"], ["Part Type", "Brake Pads"], ["Brand", "Brembo"]]);
    const front = exact.rows.find((r) => r.Position === "Front");
    const rear = exact.rows.find((r) => r.Position === "Rear");
    ok(
      "LT29 SKU link (case-insensitive) names the product; draft product is not linked",
      exact.matched_rows === 2 && front?.product === "Ceramic Brake Pads — Honda Civic 2012-2016" && rear !== undefined && rear.product === undefined &&
        exact.linkedProducts.get("gid://shopify/Product/990001") === "Ceramic Brake Pads — Honda Civic 2012-2016" && exact.linkedProducts.size === 1,
      JSON.stringify(exact.rows),
    );
    ok("LT30 narrow_by offers Position when both remain", Boolean(exact.narrow_by?.Position));
    const noLink = await search.lookupTableRows(B, "Vehicle fitment", [{ column: "Make", value: "Honda" }, { column: "Model", value: "Civic" }, { column: "Year", value: "2015" }, { column: "Engine", value: "1.8L Petrol" }, { column: "Part Type", value: "Brake Pads" }, { column: "Brand", value: "Brembo" }], { tables, linkProducts: false });
    ok("LT31 product info switched off → no links", noLink.linkedProducts.size === 0 && noLink.rows.every((r) => !r.product));

    console.log("\n── Ranges + edits");
    const rangeCsv = [
      "Brand,Model,Year From,Year To,Generation,Size",
      "Honda,Civic,2012,2016,9th gen,\"205/55 R16\"",
      "Honda,Civic,2017,,10th gen,215/50 R17",
      "Honda,Civic,2006-2011,,8th gen,195/65 R15",
    ].join("\n");
    const rangeTable = await lookup.createTableSource(
      B,
      { title: "Tyre sizes", description: "Tyre size per car generation", filename: "tyres.csv", roles: ["filter", "filter", "info", "info", "info", "info"], bytes: Buffer.from(rangeCsv), gzipped: false },
      { enqueue: false },
    ).catch((e) => e);
    ok(
      "LT32 an imported table's rows count against the limit for the next upload",
      (rangeTable instanceof lookup.TableUploadError) === 200_003 > plusRows,
      `limit=${plusRows} refused=${rangeTable instanceof lookup.TableUploadError}`,
    );
    if (!(rangeTable instanceof Error)) await deleteSource(B, rangeTable.id);
    await db.shop.update({ where: { id: B }, data: { plan: "plus" } });
    // Make room: drop 10 rows' worth by switching the limit check to a fresh shop.
    const C = (await db.shop.upsert({ where: { domain: "qa-lookup-c.myshopify.com" }, update: { plan: "free" }, create: { domain: "qa-lookup-c.myshopify.com", plan: "free" } })).id;
    const tyres = await lookup.createTableSource(
      C,
      { title: "Tyre sizes", description: "Tyre size per car generation", filename: "tyres.csv", roles: ["filter", "filter", "info", "info", "info", "info"], bytes: Buffer.from(rangeCsv), gzipped: false },
      { enqueue: false },
    );
    await ingestSource(C, tyres.id);
    const cTables = await search.activeLookupTables(C);
    ok("LT33 'Year From'/'Year To' become one Year filter", cTables[0]?.ranges[0]?.name === "Year");
    const y2015 = await search.lookupTableRows(C, "tyre sizes", [{ column: "Brand", value: "Honda" }, { column: "Year", value: "2015" }], { tables: cTables });
    const y2020 = await search.lookupTableRows(C, "Tyre sizes", [{ column: "Year", value: "2020" }], { tables: cTables });
    ok("LT34 year inside a from/to range; open-ended 'to' matches later years", y2015.matched_rows === 1 && y2015.rows[0].Generation === "9th gen" && y2020.matched_rows === 1 && y2020.rows[0].Generation === "10th gen", JSON.stringify([y2015.rows, y2020.rows]));
    const y2008 = await search.lookupTableRows(C, "Tyre sizes", [{ column: "Year", value: "2008" }], { tables: cTables });
    ok("LT35 a '2006-2011' cell in the From column counts as its range", y2008.matched_rows === 1 && y2008.rows[0].Generation === "8th gen", JSON.stringify(y2008));
    await lookup.updateTableSource(C, tyres.id, { name: "Tyre sizes", description: "Tyre sizes", roles: { c0: "filter", c1: "ignore" }, status: "active" });
    const edited = await search.activeLookupTables(C);
    const hidden = await search.lookupTableRows(C, "Tyre sizes", [{ column: "Model", value: "Civic" }, { column: "Brand", value: "Honda" }], { tables: edited });
    ok("LT36 edit roles without re-import: ignored column is no longer a filter or shown", (hidden.ignored_filters ?? []).includes("Model") && hidden.rows.every((r) => !("Model" in r)));
    const noFilter = await lookup.updateTableSource(C, tyres.id, { name: "Tyre sizes", description: "x", roles: { c0: "info" }, status: "active" }).catch((e) => e);
    ok("LT37 edit leaving no filter is refused", noFilter instanceof lookup.TableUploadError);
    await lookup.updateTableSource(C, tyres.id, { name: "Tyre sizes", description: "x", roles: {}, status: "inactive" });
    ok("LT38 inactive table isn't offered to the agent", (await search.activeLookupTables(C)).length === 0);

    console.log("\n── Quotas, tenancy, delete");
    const fileLimitShop = await db.shop.update({ where: { id: C }, data: { plan: "free" } });
    await createSource(C, { type: "file", name: "a.txt", mime: "text/plain", bytes: Buffer.from("hello") }, { enqueueIngest: false });
    const overFiles = await createSource(C, { type: "file", name: "b.txt", mime: "text/plain", bytes: Buffer.from("hello") }, { enqueueIngest: false }).catch((e) => e);
    ok("LT39 a table counts as a file upload (Free: 2)", overFiles instanceof QuotaError && fileLimitShop.plan === "free");
    ok("LT40 shop A sees none of shop B's tables", (await search.activeLookupTables(A)).length === 0);
    const cross = await search.lookupTableRows(A, "Vehicle fitment", [{ column: "Make", value: "Honda" }], { tables });
    ok("LT41 even with B's table metadata, A's query returns no rows (shopId in SQL)", cross.rows.length === 0 && cross.matched_rows === 0);
    t0 = Date.now();
    await deleteSource(B, table.id);
    ok(
      "LT42 delete removes the table's rows and file",
      (await db.lookupRow.count({ where: { dataSourceId: table.id } })) === 0 && (await db.lookupFile.count({ where: { dataSourceId: table.id } })) === 0,
      `${Date.now() - t0}ms`,
    );
    await cleanupShop("qa-lookup-c.myshopify.com");
    ok("LT43 cleanupShop leaves no lookup rows or files", (await db.lookupRow.count({ where: { shopId: C } })) === 0 && (await db.lookupFile.count({ where: { shopId: C } })) === 0);
    await db.shop.deleteMany({ where: { domain: "qa-lookup-c.myshopify.com" } });
  } finally {
    await resetShops();
    await db.$disconnect();
  }

  console.log(`\nlookup-tables: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
