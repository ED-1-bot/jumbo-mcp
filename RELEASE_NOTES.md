# Jumbo MCP Server Release Notes

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
