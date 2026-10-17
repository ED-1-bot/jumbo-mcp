# Jumbo MCP Server Release Notes

## What's New in v0.3.0

### 1. Migration to MCP TypeScript SDK v2
* **Modern MCP Server Architecture**: Migrated to MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.3.1) using `McpServer`.
* **Direct Zod Tool Schemas**: Converted tool registrations to type-safe Zod schema definitions with `server.registerTool(...)`, eliminating manual JSON schema boilerplate and ensuring end-to-end input and output validation.
* **Streamlined Core Dependencies**: Dropped direct `@modelcontextprotocol/core` dependency and updated documentation to require Node.js `>= 20` matching the v2 SDK runtime baseline.

### 2. Automated Stealth Browser Login & Cloudflare Turnstile Handling
* **Stealth Browser Automation**: Integrated Playwright with `puppeteer-extra-plugin-stealth` (`playwright-extra`) to automate the web login flow and solve Cloudflare Turnstile bot challenges.
* **Clean Refresh Token Extraction**: `npm run login` cleanly extracts the permanent Auth0 refresh token (`JUMBO_REFRESH_TOKEN=...`) directly to stdout for seamless copy-pasting into `.env` or container configurations.
* **Optional Token Storage**: Maintained `--save` flag support to persist tokens to disk (`~/.config/jumbo-mcp/tokens.json`) when file-based storage is preferred over environment variables.

### 3. Test Suite Expansion & Modern SDK Test Layer
* **106 Automated Tests**: Expanded test suite to 106 automated tests covering all client endpoints, authentication mechanisms, and MCP tool handlers.
* **In-Memory MCP Client Integration Tests**: Updated `test/tool-layer.test.ts` to spin up in-memory client/server pairs using `@modelcontextprotocol/client` 2.3.1 and `InMemoryTransport`, verifying all 18 MCP tools, Zod schema validation, and error propagation.
* **Browser Flow Unit Tests**: Added unit tests with mock Playwright interfaces (`test/auth-browser.test.ts`) covering automated browser flows, token parsing, and error handling.

---

## What's New in v0.2.2

### 1. Multi-Line Receipt Item & Quantity Parsing
* **Quantity & Unit Price Extraction**: The digital receipt parser (`parseReceiptDoc`) now properly parses multi-line receipt entries where quantity multipliers are printed on sublines (e.g. `S MICHAEL RIESLING` followed by `2 X 4,99  9,98`).
* **Enhanced ReceiptItem Model**: Extended `ReceiptItem` with `quantity` and `unit_price` while preserving the exact line total `price`. This ensures accounting accuracy where line prices sum up to the exact receipt total.
* **Product Name Recovery**: Restored missing product titles for multi-quantity items that were previously misnamed as `"2 X 4,99"`.

### 2. Promo Digest Precision & Noise Filtering
* **Unit-Accurate Frequency Mining**: Purchase frequency calculations in `jumbo_get_promo_digest` now accumulate actual item units bought (`item.quantity`) rather than line counts.
* **Non-Product Filtering**: Filtered out container deposits (`STATIEGELD`) and discount deduction credits from frequent grocery mining, eliminating wasted search calls.
* **False-Match Prevention**: Eliminated false positive catalog matches (such as matching Coca-Cola for stray `"2 X 2,49"` lines).
* **Brand-Stripped Search Fallback**: `searchProductForDigest` now falls back to a stripped store-brand query (`^JUMBO['’S]*\s+`) if literal POS keyword queries yield 0 results, substantially increasing promo match rates for private-label goods.

### 3. Receipt ID Resolution & Candidate Caching
* **Adaptive ID Form Memory**: `getReceiptDetails` and `receiptIdCandidates` now remember the successful candidate ID form across calls, reducing repeat probing HTTP traffic by up to 75% on batch scans.
* **Regex Hoisting**: Hoisted UUID parsing regular expressions and added early returns for empty or whitespace-only inputs.

### 4. GraphQL Operation Hygiene
* **Unused Variable Removal**: Dropped the unused `$orderChannel` variable declaration from the `ActiveBasket` query, resolving `GRAPHQL_VALIDATION_FAILED` errors on `jumbo_get_basket`.
* **Static Schema Verification**: Added automated tests guarding every GraphQL operation document against declared-but-unused variables.

### 5. Test Suite Expansion
* Expanded automated test suite to 103 tests covering multi-line receipt parsing, unit price/quantity tracking, brand fallback matching, and GraphQL hygiene.

---

## What's New in v0.2.1

### 1. Critical Auth0 Session Refresh & Audience Fix
* **Token Renewal Audience & Scope**: Fixed a critical issue where the Auth0 `refresh_token` grant omitted the target `audience` and `scope`, resulting in tokens issued without the essential `https://jumbo.com/customerId` claim. This previously caused Jumbo's GraphQL router to reject requests with `401 UNAUTHORIZED Customer ID header is required` / `Customer ID cannot be null or empty`.
* **Pre-persistence JWT Validation**: Refreshed tokens are now strictly inspected for correct audience (`https://jumbo.com/`) and valid `customerId` claim before persisting to storage.
* **Mid-flight Token Invalidation Guard**: Stale environment tokens (`JUMBO_TOKEN`) are ignored during active session refresh so they do not override newly minted credentials.
* **Actionable Session Errors**: Upstream authentication/authorization failures now raise a dedicated `JumboSessionInvalidError` with actionable resolution guidance (`npm run login`) instead of surfacing raw GraphQL errors.

### 2. Test Suite Expansion
* Added 14 new automated tests covering Auth0 refresh parameter validation, audience/claim rejection guards, and mid-flight token refresh replay behavior (expanding test suite to 82 tests).

---

## What's New in v0.2.0

### 1. Shopping List Management & Mutations (Write Operations)
Four new tools to manage your Jumbo shopping list (*lijstje*) autonomously or interactively:
* `jumbo_add_shopping_list_items`: Add free-text items (e.g. `['eieren', 'havermelk']`). Includes automatic list activation (`ensure_active=true`) and case-insensitive deduplication (`dedupe=true`).
* `jumbo_remove_shopping_list_items`: Remove items from your active list by item ID.
* `jumbo_set_shopping_list_item_completed`: Mark items as completed (checked off) or back on.
* `jumbo_set_shopping_list_active`: Toggle your shopping list active or inactive.

### 2. Personalized Promotional Intelligence
* `jumbo_get_promo_digest`: Answers *"of the things I actually buy, what is on offer right now?"*.
  * Scans receipt history within a configurable window (`days`, default: 90) and purchase threshold (`min_times`, default: 2).
  * Resolves frequent items to live catalog products and matches them against active promotions.
  * Reports was/now pricing, discount amounts, promo labels, validity dates, unit prices, and account-level offers.
  * Implements jittered request throttling (120–200ms) to ensure gentle API interaction.

### 3. Account Insights & Order Breakdown (Read-Only)
* `jumbo_get_basket`: Live view of your current active web/mobile basket lines, quantities, unit prices, promotions applied, and subtotal.
* `jumbo_get_deposits`: Order-scoped *statiegeld* deposit catalogue and returned deposit refunds for a given `order_id`.
* `jumbo_get_stamps`: Digital stamps balance, active saving (*spaar*) campaigns, and buying-stamps balance.

### 4. Robust Error Handling & Security
* **GraphQL Union Error Handling:** Upstream errors from `ShoppingListError` and `BasketError` now cleanly surface Jumbo's native `reason` and `errorMessage` payloads.
* **Credential Protection:** Guaranteed zero access/refresh token leakage into client error payloads.

### 5. Automated Test Suite & Multi-Stage Docker
* Comprehensive **68-test unit suite** (`npm test`) covering client operations, MCP tool routing, Zod input validation, and promo digest internals.
* Multi-stage `Dockerfile` and support for global linking (`npm link`) or direct execution (`node dist/index.js`).

---

## What's New in v0.1.0

### 1. Zero-Maintenance Auth0 Authentication
* **Auth0 PKCE Flow:** Official OAuth2 PKCE login flow via `npm run login`.
* **Persistent Refresh Token:** Generates a secure, persistent refresh token stored locally in `~/.config/jumbo-mcp/tokens.json`.
* **Automatic Token Lifecycle:** Automatically refreshes 24-hour access tokens in the background on demand.
* **Headless & VPS Gateway Support:** Can be deployed to remote servers and Docker containers with volume mounts and `JUMBO_REFRESH_TOKEN` / `JUMBO_TOKEN`.

### 2. Full Suite of 10 MCP Tools
* `jumbo_login`: Authenticate and verify active connection, returning user loyalty identity.
* `jumbo_get_profile`: Retrieve customer loyalty profile, name, customer ID, Extra's card details, and digital receipt preferences.
* `jumbo_list_receipts`: List recent store receipts (*kassabonnen*) with timestamps, store locations, and transaction IDs.
* `jumbo_get_receipt_details`: Retrieve full itemized line items, unit prices, discounts, totals, payment methods, and VAT breakdowns for a specific receipt.
* `jumbo_search_receipts`: Search past receipts by product keyword (e.g. `'havermelk'`, `'bio ei'`, `'skyr'`).
* `jumbo_get_balance`: Retrieve live Jumbo Extra's loyalty points balance.
* `jumbo_get_shopping_list`: Retrieve the customer's active shopping list items.
* `jumbo_search_stores`: Find nearby Jumbo stores by city, address, Dutch postal code, or geographic coordinates (`latitude`, `longitude`). Returns addresses, distance in km, full weekly opening hours, and store facilities.
* `jumbo_search_products`: Search the entire live Jumbo supermarket grocery catalog by keyword. Returns matching products, current prices, promotional tags, unit prices, product URLs, and SKUs with optional price sorting (`PRICE_ASC` / `PRICE_DESC`).
* `jumbo_get_product_recommendations`: Retrieve product recommendations, brand alternatives, and cross-sell suggestions by SKU or search query, or fetch current weekly promotional deals.

### 3. Developer Resources & CLI Utilities
* CLI Utility Commands: `npm run login`, `npm run status`, `npm run build`.

---

*License: MIT - Copyright (c) 2026 Robert Schulze Dieckhoff*
