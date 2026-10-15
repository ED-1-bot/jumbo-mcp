# Jumbo MCP Server v0.1.0 Release Notes

A Model Context Protocol (MCP) server for **Jumbo Supermarkten**, providing secure access to digital store receipts (*kassabonnen*), loyalty points, store locators, grocery product search, and recommendations for AI assistants (Claude Desktop, Cursor, Antigravity, OpenClaw, and autonomous agents).

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
* **CLI Utility Commands:**
  * `npm run login`: Interactive terminal login wizard.
  * `npm run status`: Live connectivity check, token validation, and Extra's balance verification.
  * `npm run build`: TypeScript compiler to executable Node bundle (`dist/index.js`).

---

## Quick Installation

```bash
# Clone and build
git clone https://github.com/Robert-SD/jumbo-mcp.git
cd jumbo-mcp
npm install
npm run build

# Authenticate once
npm run login

# Verify connection
npm run status
```

## Client Integration (Claude Desktop / Cursor)

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "jumbo": {
      "command": "node",
      "args": ["/absolute/path/to/jumbo-mcp/dist/index.js"]
    }
  }
}
```

---
*License: MIT - Copyright (c) 2026 Robert Schulze Dieckhoff*
