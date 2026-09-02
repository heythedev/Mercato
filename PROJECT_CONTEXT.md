# Mercato — Technical Project Context

> Generated 2026-07-23 from the `main` branch. This is a technical reference for
> engineers picking up the codebase: what it does, how it is wired, and where the
> non-obvious decisions live.

---

## 1. What the product does

Mercato is an internal **product-catalog ingestion and marketplace-listing pipeline**.

A user uploads a vendor's spreadsheet (Excel/CSV), and the app runs it through four stages:

```
Upload → Verify → Categorize → Export
```

1. **Upload** — parse an arbitrary vendor sheet into normalized `Product` rows.
2. **Verify** — check each product against the live marketplace catalog
   (Amazon via Keepa, Walmart via the Walmart Affiliate API), field by field,
   including AI visual comparison of product images.
3. **Categorize** — assign each product a leaf path from the target marketplace's
   taxonomy using Claude, constrained to a fixed CSV taxonomy sheet.
4. **Export** — produce marketplace-ready `.xlsx` files, either filling the
   marketplace's own uploaded template workbook (preserving styles, column widths
   and dropdown validations) or generating a flat workbook from scratch.

Supported marketplaces: `amazon` / `amazon_us`, `walmart`, `temu`, `bestbuy`,
`mathis` (Mathis Brothers, via Mirakl), `sears`. Only Amazon and Walmart have live
verification; the rest pass through as `ok`.

---

## 2. Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js **16.2.9**, App Router, React **19.2.4** |
| Language | TypeScript 5 (`strict: true`), path alias `@/* → ./src/*` |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`), `next-themes` dark/light |
| UI | Custom components + `lucide-react`, `sonner` toasts, `class-variance-authority`, `tailwind-merge` |
| DB | PostgreSQL via **Prisma 7.8** with the `@prisma/adapter-pg` driver adapter (`pg` pool) |
| Auth | **NextAuth v5 beta** (`5.0.0-beta.31`), JWT sessions, Credentials + Google |
| AI | Vercel AI SDK v6 (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`) — Claude for all live paths |
| Spreadsheets | `exceljs` + `jszip` + hand-rolled OOXML readers/writers |
| Validation | `zod` v4 |
| Package manager | **pnpm** (workspace file present, `pnpm-lock.yaml` committed) |
| Test runner | `vitest` (dev dependency; no test files currently in the repo) |

Scripts:

```jsonc
"dev":     "next dev",
"build":   "prisma generate && prisma migrate deploy && next build",  // migrates on build
"start":   "next start -p 3020",
"db:seed": "tsx prisma/seed.ts"                                       // seeds the admin user
```

---

## 3. Repository layout

```
prisma/
  schema.prisma            # 8 models — auth, core, Keepa cache, templates
  migrations/              # 4 migrations, latest: 20260720054536_add_keepa_cache
  seed.ts                  # upserts an admin from ADMIN_EMAIL / ADMIN_PASSWORD

src/
  auth.ts                  # NextAuth instance: Credentials (bcrypt) + optional Google
  auth.config.ts           # edge-safe config: JWT strategy, custom "mercato.*" cookie names
  proxy.ts                 # auth middleware — redirects unauthenticated users to /login

  app/
    (auth)/login/          # sign-in page
    (app)/                 # authenticated shell (sidebar + navbar)
      projects/            # list, new, [id] detail (the 4-step wizard)
      templates/           # user template management
      admin/users|templates
    api/
      auth/[...nextauth]/
      projects/            # GET list / POST upload / DELETE bulk
        [id]/              # GET detail, DELETE
          verify/          # POST run verification (+ /report GET → CSV)
          categorize/      # POST AI categorize, PUT import categories from CSV
          export/          # POST start job → { jobId }, GET poll/download ZIP
      products/[id]/       # PATCH verifyStatus (manual override)
      templates/           # CRUD + POST /detect (AI category detection)
      users/               # admin-only CRUD
      admin/temu-categories, admin/walmart-test

  components/
    layout/                # sidebar, navbar, sidebar-context
    projects/              # projects-view (835 LOC), project-detail, products-table
      steps/               # verify-step, categorize-step, export-step
    admin/                 # templates-client, users-client
    ui/                    # confirm-dialog

  lib/
    db.ts                  # global Prisma singleton with pg adapter (keepAlive, 30s idle)
    auth-helpers.ts        # requireUser/requireAdmin (redirect) + authGuard/adminGuard (JSON 401/403)
    barcode.ts             # GTIN-14 canonicalization + ASIN regex
    vendor/parse.ts        # vendor sheet → VendorRow[] (column detection heuristics)
    vendor/xlsx-lite.ts    # fast raw-XML xlsx grid reader (ExcelJS hangs on validations)
    marketplaces/verify.ts # ★ 1484 LOC — the whole verification engine
    keepa/                 # Keepa API client, cache, normalization, types, domains
    walmart/client.ts      # Walmart Affiliate API (RSA-SHA256 request signing)
    ai/                    # categorize, resolve-sku, compare-images, generate-title,
                           # match-dropdown, taxonomies, vendor-catalog
      data/*.csv           # temu_categories.csv (648 rows), mathis_categories.csv (505)
    export/zip.ts          # ★ 1536 LOC — template filling + workbook generation
    export/{filename,category-group,job-store}.ts
    projects/recover-stale.ts
```

The two files that carry most of the domain complexity are
[verify.ts](src/lib/marketplaces/verify.ts) and [zip.ts](src/lib/export/zip.ts).
Read those two before changing anything in the pipeline.

---

## 4. Data model

`prisma/schema.prisma` — PostgreSQL, `prisma-client-js` generator.

### Auth
`User` (with `role: "user" | "admin"`, bcrypt `password`), plus standard NextAuth
`Account` / `Session` / `VerificationToken` tables. Sessions are JWT, so the
`Session` table is effectively vestigial.

### Core

**`Project`** — `marketplace` string, and a `status` that doubles as the wizard's
state machine:

```
uploaded → verifying → verified → categorizing → categorized → exporting → done
```

`verifying`, `categorizing` and `exporting` are **transient** statuses written at
the *start* of a long request. See §7 (stale recovery).

**`Product`** — identity (`vendorSku`, `upc`, `asin`, `name`, `brand`, `price`,
`imageUrl`), plus `vendorData Json` holding the *full raw vendor row*. Three
result groups are written back in place:

- Verification: `verifyStatus`, `liveData` (raw marketplace response),
  `verifyFields` (field-by-field comparison array), `verifiedAt`
- Categorization: `marketplaceCategory`, `categoryPath`, `categoryConfidence`, `categorizedAt`
- Indexed on `upc` and `asin`

`vendorData` is the escape hatch — the export field resolver and category/model-number
extractors all mine it for columns the normalized schema doesn't have.

### Keepa cache (cost control)

Keepa bills per product token, so two cache tables exist with deliberately
different lifetimes — the schema comments explain why:

**`KeepaCodeLookup`** — `(code GTIN-14, domain) → asins[]`. An empty `asins` array
is a **negative cache** ("confirmed absent from Amazon"). `source` is
`batch | rescue | keyword`; keyword matches are fuzzy guesses so they expire
sooner. This is the expensive half to miss — an unresolved code costs a rescue
call plus up to ~10 keyword searches.

**`KeepaProductCache`** — `(asin, domain) → raw Keepa payload`. Stores the **raw**
payload, not the normalized shape, because `normalizeProduct()` is pure — keeping
it outside the cache boundary means normalization logic can change without
invalidating rows. `priceAt` is split from `fetchedAt` because price ages
differently from identity fields.

TTLs in [cache.ts](src/lib/keepa/cache.ts): negative 30d, keyword 7d, price 12h.
Rows past the price TTL are still served for identity with price *stripped*, rather
than discarded.

### Templates

**`ExportTemplate`** — `userId` null means global/admin-owned; set means
user-private. `columns Json` is the detected header list; `fileData Bytes` is the
**raw uploaded workbook**, used as the base file at export so the marketplace's
own formatting and dropdown validations survive.

---

## 5. Auth & authorization

- `src/proxy.ts` is the middleware. Everything except `/api/auth/*` and static
  assets requires a session; logged-in users hitting `/login` bounce to `/projects`.
- Cookies are namespaced `mercato.session-token` etc., with `__Secure-` / `__Host-`
  prefixes in production.
- Google sign-in **upserts** the user on first JWT callback with role `"user"`, and
  uses `allowDangerousEmailAccountLinking`. Google is only registered as a provider
  when both env vars are present.
- Route handlers use `authGuard()` / `adminGuard()` from
  [auth-helpers.ts](src/lib/auth-helpers.ts), which return `{ response }` on
  failure — every handler starts with `if (response) return response;`.
- Ownership is checked per resource: every project/product route compares
  `project.userId !== user.id → 403`.
- Templates are readable if owned by the user, `userId: null`, **or** owned by any
  admin (a legacy-compat clause — see the `adminIds` lookup in the templates route
  and the export job).

---

## 6. Pipeline stage by stage

### 6.1 Upload — `POST /api/projects`

`multipart/form-data` (`file`, `name`, `marketplace`) →
[parseVendorFile()](src/lib/vendor/parse.ts) → one `Project` with nested `Product`
creates.

Vendor sheets are wildly inconsistent, so parsing is heuristic:

- Caps: 2000 rows, 64 columns, 25 header-scan rows.
- **Header row detection** — scores the first rows and picks the most populated.
- **SKU column selection** (`pickBestSkuCol`) is scored across four layers: header
  specificity (`Vendor SKU` > `SKU` > `Item No`), value uniqueness, format quality
  (alphanumeric, consistent length, not pure digits), and a penalty for
  marketplace listing-ID prefixes like `APSA-*` / `FBA-*`.
- Barcodes are recognized by a `^\d{8,14}$` column-share test.
- A `discontinued` flag detected in the sheet is written straight to
  `verifyStatus: "discontinued"` at import.
- `.xlsx` reading goes through [xlsx-lite.ts](src/lib/vendor/xlsx-lite.ts), a raw-XML
  reader written **because ExcelJS hangs on large files with column-level data
  validations**.

### 6.2 Verify — `POST /api/projects/[id]/verify`

`maxDuration = 300`. Batches of 50, DB writes in sub-batches of 10.

**Resumability is the core design constraint.** Large catalogs cannot finish in
300s, so:

- A time budget of `maxDuration - 45` seconds stops the loop *between* batches.
- By default only products with `verifyStatus == null` are processed, so calling
  again resumes. `?force=1` re-checks everything ("Re-verify").
- The project is only marked `verified` when `remaining === 0`; otherwise it drops
  back to `uploaded` so it stays resumable. The same happens in the `catch`.
- The response carries `{ verified, skipped, remaining, complete, partial }`.
- **The client drives the resume loop** (see §10, uncommitted work) so the user
  doesn't have to click Verify five times.

**Keepa preflight** — before starting an Amazon run, the route estimates tokens
(`KEEPA_TOKENS_PER_PRODUCT = 2`, plus a 100 buffer), calls `refreshKeepaTokens()`,
and returns **HTTP 429 with `code: "INSUFFICIENT_KEEPA_TOKENS"`** and a
refill-rate-derived wait hint rather than burning a partial run.

**Amazon resolution cascade** (`verifyAmazon`, `KEEPA_DOMAIN = 1`):
cache → batch code lookup → rescue call → keyword search (up to ~10) → give up.
Both hits and confirmed misses are cached. Note the deliberate distinction in
`getProductsByCode`: it returns the codes whose batch *never completed* separately,
because "Keepa has no product for this code" must not be conflated with "we never
got to ask" — only the former is cacheable.

`pickBestCandidate` is a multi-signal scorer (title similarity, brand match, model
number, pack quantity, price sanity) used when a code resolves to multiple ASINs.
`extractPackQty` / `extractModelNumber` mine both the title and `vendorData`.

**Walmart** goes through [walmart/client.ts](src/lib/walmart/client.ts), which signs
requests with RSA-SHA256 over a canonical header string
(`WM_CONSUMER.ID`, `WM_CONSUMER.INTIMESTAMP`, `WM_SEC.KEY_VERSION` sorted and
newline-joined) using `WALMART_AFFILIATE_PRIVATE_KEY`.

**Two AI post-passes** run after the raw comparison:

1. **Image comparison** — for every product with both a catalog and marketplace
   image, one vision call judges the vendor image against *all* marketplace angles
   at once. This replaced a per-angle loop that cost 3 calls for every
   mismatch/unsure — i.e. exactly the products a verification run surfaces.
2. **Semantic title check (Walmart only)** — Walmart titles are far more verbose
   than vendor titles, so borderline `warning` titles get a SAME/DIFFERENT judgement
   from Claude, concurrency 5.

Both degrade silently to no-ops without `ANTHROPIC_API_KEY`.

**Severity model.** `HARD_FIELDS = {title, brand, model}`. Only a hard-field
mismatch escalates the product to `mismatch`; soft fields (images, description,
dimensions) cap at `warning`. This exists specifically so an AI-detected colour
variant doesn't falsely condemn a genuinely matching product.

**Report** — `GET .../verify/report` emits a UTF-8 BOM CSV. Numeric identifiers
(SKU/UPC/ASIN) are wrapped as `="""value"""` so Excel doesn't render a 12-digit
UPC as `7.56E+11`.

### 6.3 Categorize — `POST /api/projects/[id]/categorize`

`maxDuration = 300`.

**Taxonomy sheets are the source of truth**, not template names:
- Temu **and** Best Buy → `src/lib/ai/data/temu_categories.csv`
  (`Category,Subcategory,Sub-Subcategory`, ~420 leaves)
- Mathis → `mathis_categories.csv`
  (`Department,Category,Subcategory,Product Type`, ~480 leaves, from the official
  Mirakl fwd sheets)

These are read from disk at runtime, which is why `next.config.ts` declares
`outputFileTracingIncludes` for the categorize route — otherwise the CSVs are not
bundled into the serverless function.

**Prompt construction** ([categorize.ts](src/lib/ai/categorize.ts)):
- Model: `claude-sonnet-5` for constrained taxonomies, `claude-haiku-4-5` otherwise.
- Batch 5 (Temu/Mathis/BestBuy) / 8 (other constrained) / 20 (free-form), parallelism 2–3.
- Chain-of-thought: the model must state what the product *is* before assigning.
- The route mines `vendorData` for a category hint (`VENDOR_CATEGORY_KEYS`) and up
  to six supplemental signals (`VENDOR_CONTEXT_KEYS`: age group, gender, size,
  season, material, colour) to disambiguate e.g. furniture vs. costume.
- Deterministic tie-breaking rules are written into the Temu prompt ("if two leaves
  are equally plausible, choose the alphabetically first") so repeat runs are stable.

**Three safety layers, in order:**
1. **Off-list retry** — anything the model invents that isn't in the allow-list is
   re-run in strict mode, then forced to `Uncategorized`.
2. **Web-search rescue** — if `SERPAPI_KEY` is set, `Uncategorized` products are
   searched (parallelism 5) and re-categorized with that context.
3. **Confidence gate** — `CATEGORIZE_MIN_CONFIDENCE` (default **0.6**). Below it, or
   if the product name is *still* a raw SKU, the result is forced to
   `Uncategorized`. The stated policy is correctness-first: it is always safer to
   exclude a product from export and surface it for review than to file it wrongly.

**SKU-only sheet enrichment** ([resolve-sku.ts](src/lib/ai/resolve-sku.ts) +
[vendor-catalog.ts](src/lib/ai/vendor-catalog.ts)): Mathis furniture sheets often
contain nothing but codes like `TOVF-TOVL54566`. Resolution order is the vendor's
own Shopify `/products.json` catalog (downloaded once, indexed by normalized SKU,
digit-core and series letter, cached 24h) → web search → give up. When a catalog
entry is found, the vendor's JSON-LD breadcrumb category is also pulled, which
resolves the multi-room-tag ambiguity. Resolved titles/brands/descriptions are
written back to the `Product` row.

**Re-runs are idempotent by default**: only products with no category or
`Uncategorized` are reprocessed. `{ force: true }` redoes everything.

**`PUT`** on the same route imports categories from a CSV (`SKU`/`name` + `Category`
[+ `Category Path`]), matching by exact `vendorSku` then normalized name. This
supports the workflow: AI categorize → download → human review → re-upload.

### 6.4 Export — `POST /api/projects/[id]/export`

**Async job pattern.** The POST does only an ownership check, creates a job id,
returns `{ jobId }` immediately, and runs everything heavy in a floating
`void (async () => {...})()`. The client polls `GET ?jobId=`.

⚠️ [job-store.ts](src/lib/export/job-store.ts) is an **in-memory Map**. Jobs do not
survive a restart and will not work across multiple server instances. This is the
main horizontal-scaling blocker.

**Export mode selection** (in priority order):

| Condition | Mode |
| --- | --- |
| Explicit `templateIds` | `generateSingleTemplateExport` — all products, one chosen template |
| Temu/BestBuy/Walmart **with** templates | `generateCategoryZip` — group by category, match each to closest template |
| Temu/BestBuy/Walmart **without** templates | `generateFlatCategoryZip` — split by category, flat columns |
| Any marketplace, no templates | `generateFlatExport` — one file, 25 standard columns |
| `autoMatch` | `generateCategoryZip` |

Mathis **requires** templates and throws if none exist; the others degrade
gracefully.

**Grouping** ([category-group.ts](src/lib/export/category-group.ts)) — deliberately
dependency-free so client and server agree on the file count shown vs. produced:
- Mathis → first path segment (department); Mathis ingests one file per department
- Temu → `Category > Sub-Category` (dropping product type avoids hundreds of tiny files)
- Others → the full path

**Template filling** is the hardest part of the codebase (~1100 LOC in zip.ts). It
edits the uploaded workbook's XML **in place** rather than rebuilding rows, to
preserve row colours, rich-text shared strings, column widths, structure, `TABLE`
and `autoFilter` refs. Recent commits (`3505ecb`, `e35fa1b`, `55a4243`) are all
fixes in this area.

**Dropdown (dataValidation) columns** are two-tier: `pickDropdownValue` does
deterministic matching (exact → whole-word overlap, word-boundary aware so
"used - like new" hits "Used" not "New" → collapsed substring). Anything
unresolved is batched to Claude by
[match-dropdown.ts](src/lib/ai/match-dropdown.ts) (`Charcoal → Grey`,
`Boucle → Fabric`), which may only return a verbatim option or `""`. Failures are
non-fatal — an export never breaks on an AI error.

**Field resolution** — `getProductField` maps a template column key onto the
`Product` row, falling back to a normalized `vendorData` lookup cached in a
`WeakMap`. `normalizeKey` strips all separators so CamelCase headers match
underscore keys (fix `7fbbad7`).

**Walmart titles** are AI-regenerated at export
([generate-title.ts](src/lib/ai/generate-title.ts)) rather than copied verbatim —
per-marketplace length rules plus attributes mined from `vendorData`. It falls back
to the vendor name on any error.

Downloads are named `mercato-{project}-{marketplace}-{DD-MM-YYYY}.zip` via
[filename.ts](src/lib/export/filename.ts), which emits both RFC 6266 forms
(ASCII `filename=` and percent-encoded `filename*=`).

---

## 7. Cross-cutting mechanisms worth knowing

**Stale-project recovery** ([recover-stale.ts](src/lib/projects/recover-stale.ts)).
Transient statuses are written at the start of a long request and cleared only when
that same request finishes. A 300s timeout, restart, crash or laptop sleep strands
the project forever. Any project sitting in a transient status for more than
**6 minutes** is mapped back to the stable status its own route's error handler
would have used. This runs opportunistically on `GET /api/projects` (scoped by
`userId`) and `GET /api/projects/[id]` (scoped by `id`).

**Barcode identity** ([barcode.ts](src/lib/barcode.ts)). `toGtin14()` collapses
UPC-A / EAN-13 / ITF-14 / Excel-mangled floats to one canonical 14-digit form —
this is the cache key and dedupe key. `barcodeVariants()` deliberately returns
*multiple* forms to query external APIs with, since Keepa indexes under whichever
form the catalog happens to carry. `toDisplayBarcode()` preserves the legacy
display form for the `Product.upc` column (changing it would be a migration).
`ASIN_RE` is intentionally looser than `B0…` because legacy ASINs exist and a false
negative costs a full keyword cascade while a false positive self-corrects.

**Image download cache** ([compare-images.ts](src/lib/ai/compare-images.ts)).
`withImageCache()` scopes a per-run URL→bytes cache. It is explicitly *not* a
module-level cache, which would pin megabytes for the life of the process.
Limits: 5 MB per image, `image/(jpeg|png|gif|webp)` only.

**AI availability guard** ([moonshot.ts](src/lib/ai/moonshot.ts)). Every AI
feature spends one Moonshot (Kimi) balance; when it drains the platform answers
every call with HTTP 429 `exceeded_current_quota_error` — the same status as a
rate limit. The provider fetch rewrites that into a non-retryable 402, records
an outage so later calls short-circuit (no downloads, no SDK retries), and
`checkAiAvailable()` is the preflight the verify, sweep, single re-verify,
manual compare and categorize routes call before any AI work. A fatal failure
(balance, key, retired model) is never written to a product: `applyAiVerificationPasses`
returns `{ aiUnavailable, untouched }`, callers skip persisting `untouched`
rows, the sweep answers `aiUnavailable`, and the verify step shows a red
"paused" banner with Retry instead of a spinner. Rows finalized during an
outage before this guard (notes matching `REQUEUE_NOTE_FRAGMENTS` in
[image-check-state.ts](src/lib/marketplaces/image-check-state.ts)) are picked
up by the sweep again and judged for real. The vision verdict call runs
kimi-k2.6 in non-thinking mode (`thinking: disabled`, sent as a header the
provider fetch turns into the body field) — with thinking on, more than half
the calls returned empty text at full output price.

**Prisma singleton** ([db.ts](src/lib/db.ts)) — cached on `globalThis` in
development to survive HMR; pg pool with `keepAlive`, 30s idle, 10s connect timeout.

**Marketplace family aliasing** — `amazon` and `amazon_us` share a template pool,
and template marketplace matching is case-insensitive (`mode: "insensitive"`),
because historic rows have inconsistent casing (`Mathis` vs `mathis`).

---

## 8. Frontend architecture

Server Components fetch and pass initial data down; interactive views are
`"use client"`.

- `(app)/layout.tsx` — auth-gated shell with sidebar (`sidebar-context.tsx` holds
  collapse state) and navbar.
- `projects-view.tsx` (835 LOC) — the project list: filtering, bulk selection,
  bulk delete, status badges.
- `project-detail.tsx` — the wizard shell. Derives the current step from
  `project.status` via a `STEPS` array, and owns the verify/categorize/export
  action handlers.
- `steps/verify-step.tsx` — per-product field comparison table, image thumbnails
  with modal preview, marketplace product links, manual status override
  (`PATCH /api/products/[id]`), CSV report download.
- `steps/categorize-step.tsx` — run/force-run, category distribution, CSV
  import/export round-trip.
- `steps/export-step.tsx` — template picker (with Admin badges), predicted file
  count via the shared `exportGroupOf`, job polling and download.

Feedback is `sonner` toasts throughout; destructive actions route through
`ui/confirm-dialog.tsx`.

---

## 9. Environment variables

```bash
# Database
DATABASE_URL=postgresql://...

# Auth
AUTH_SECRET=            # required
AUTH_GOOGLE_ID=         # optional — Google provider only registers if both are set
AUTH_GOOGLE_SECRET=
APP_BASE_URL=

# Admin seed (prisma/seed.ts)
ADMIN_EMAIL= ADMIN_NAME= ADMIN_PASSWORD=

# AI
ANTHROPIC_API_KEY=              # image compare, title check, categorize, dropdown match
OPENAI_API_KEY=                 # SDK installed; not on any live path
DEFAULT_ANTHROPIC_MODEL=        # default claude-haiku-4-5-20251001
CATEGORIZE_ANTHROPIC_MODEL=     # default claude-sonnet-5
TITLE_ANTHROPIC_MODEL=          # default claude-haiku-4-5-20251001
DROPDOWN_ANTHROPIC_MODEL=       # default claude-haiku-4-5-20251001
CATEGORIZE_MIN_CONFIDENCE=      # default 0.6

# Marketplaces
KEEPA_API_KEY=                  # Amazon verification
SERPAPI_KEY=                    # optional — web-search rescue for Uncategorized
WALMART_AFFILIATE_CONSUMER_ID=
WALMART_AFFILIATE_PRIVATE_KEY=  # PEM, \n-escaped
WALMART_AFFILIATE_KEY_VERSION=
WALMART_CLIENT_ID= WALMART_CLIENT_SECRET= WALMART_SELLER_ID=
BESTBUY_API_KEY=                # referenced in the env template; no live code path
```

Every AI feature is written to degrade to a no-op when its key is missing.

⚠️ **`.env` is currently committed to the repository with live secrets in it.**
It should be removed from version control and every key in it rotated.

---

## 10. Current state of the working tree

Three files are modified but uncommitted, all part of one change — **making
verification finish in a single user action**:

- [verify/route.ts](src/app/api/projects/[id]/verify/route.ts) — wraps the batch
  loop in `withImageCache()` so one image-download cache spans the whole run.
- [compare-images.ts](src/lib/ai/compare-images.ts) (+147/-19) — adds the per-run
  cache and `compareVendorAgainstAllImages`, collapsing the old per-angle loop
  (1 call on match, 3 on mismatch) into a flat 1 vision call per product.
- [project-detail.tsx](src/components/projects/project-detail.tsx) — the client now
  drives the resume loop, re-POSTing while the server reports `remaining > 0` and
  showing cumulative `{ done, total }` progress. Only the first request carries
  `force` (otherwise it would loop forever re-checking finished products).

Recent history is dominated by Temu category-mapping accuracy (`407fea6`, `5b782b0`),
a reverted Wayfair integration (`d677cf7` → `ca755ad`), Mathis export fixes, and
template formatting preservation.

---

## 11. Known constraints & technical debt

1. **In-memory export job store** — no persistence, no multi-instance support.
   The single biggest blocker to horizontal scaling.
2. **`.env` committed with live credentials** (see §9). Rotate and gitignore.
3. **No tests.** `vitest` is installed; zero test files exist. `verify.ts`'s
   candidate scoring and `parse.ts`'s column detection are the highest-value
   targets — both are pure, heuristic, and currently unverified.
4. **`migrate deploy` runs inside `build`**, so a build failure can leave schema and
   code out of step.
5. **Two files carry most of the risk**: `verify.ts` (1484 LOC) and `zip.ts` (1536
   LOC). Neither has a seam that would let you test a piece in isolation.
6. **300s ceiling everywhere.** Verify and categorize both work around it; export
   sidesteps it via the background job. Any new long operation needs the same
   treatment plus a `RECOVERY` entry in `recover-stale.ts`.
7. **Vestigial code paths** — `verifyBestBuy` and `verifySerpApi` exist in
   `verify.ts` but are unreachable from the `verifyProducts` switch; the OpenAI SDK
   is installed but unused; the `Session` table is unused under the JWT strategy.
8. **README is the unmodified `create-next-app` boilerplate** and documents nothing
   about this application.

---

## 12. Onboarding path

```bash
pnpm install
cp .env.example .env          # ⚠️ does not exist yet — copy keys from §9
pnpm prisma migrate deploy
pnpm db:seed                  # creates the admin from ADMIN_EMAIL/ADMIN_PASSWORD
pnpm dev                      # dev on :3000, `pnpm start` runs prod on :3020
```

Then read, in order:
[schema.prisma](prisma/schema.prisma) →
[project-detail.tsx](src/components/projects/project-detail.tsx) (the flow) →
[verify.ts](src/lib/marketplaces/verify.ts) →
[categorize.ts](src/lib/ai/categorize.ts) →
[zip.ts](src/lib/export/zip.ts).

The codebase is unusually well commented — most non-obvious decisions have a
"why" comment above them, including in the Prisma schema. Trust those comments;
they are more current than this document will be.
