# Jumbo MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-0.1.0-green.svg)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

A Model Context Protocol (MCP) server for **Jumbo Supermarkten**.

Connect your AI assistant (Claude Desktop, Cursor, OpenClaw, …) to your personal Jumbo account to read **digital receipts (*kassabonnen*)**, itemized prices and discounts, Extra's loyalty points, stores and products — and to manage your **shopping list (*lijstje*)**.

---

## Install

Requires Node.js `>= 18`. Add the server to your MCP client config:

```json
{
  "mcpServers": {
    "jumbo": { "command": "npx", "args": ["-y", "jumbo-mcp"] }
  }
}
```

| Client | Config file |
| :--- | :--- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)<br>`%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| Cursor | `~/.cursor/mcp.json` |
| Other clients | the same `mcpServers` block |

---

## Authentication

One-time login through Jumbo's official Auth0 page. The server then stores a refresh token locally and renews access tokens automatically.

```bash
npx jumbo-mcp login     # opens the browser; paste the redirected jumbo://callbacks/... URL back
npx jumbo-mcp status    # verify the connection
```

The token is saved to `~/.config/jumbo-mcp/tokens.json`.

**Headless host (Docker, systemd, remote gateway):** copy that file to the host, or set the token directly:

```bash
JUMBO_REFRESH_TOKEN="your_refresh_token_here"
```

---

## Tools

| Tool | Description | Parameters |
| :--- | :--- | :--- |
| `jumbo_login` | Verify the connection and return the loyalty identity and points balance. | — |
| `jumbo_get_profile` | Loyalty profile: name, customer ID, Extra's card, receipt preferences. | — |
| `jumbo_list_receipts` | Recent receipts with timestamps, store and transaction IDs. | `page` (`0`), `page_size` (`10`, max `30`) |
| `jumbo_get_receipt_details` | Full itemized lines, unit prices, discounts, total, payment method, VAT. | `transaction_id` (required) |
| `jumbo_search_receipts` | Find items bought across recent receipts by keyword (e.g. `'havermelk'`). | `query` (required), `max_receipts` (`10`) |
| `jumbo_get_balance` | Live Extra's loyalty points balance. | — |
| `jumbo_get_shopping_list` | The shopping list: `isActive` plus every item. | — |
| `jumbo_add_shopping_list_items` | **Write.** Add free-text items (e.g. `['eieren']`); activates the list if needed. | `items` (required), `ensure_active` (`true`), `dedupe` (`true`) |
| `jumbo_remove_shopping_list_items` | **Write.** Remove items by id. | `item_ids` (required) |
| `jumbo_set_shopping_list_item_completed` | **Write.** Tick an item off or back on. | `item_id`, `completed` (both required) |
| `jumbo_set_shopping_list_active` | **Write.** Activate or deactivate the list. | `active` (required) |
| `jumbo_search_stores` | Nearby stores by city, address or coordinates: address, distance, hours. | `query`, `latitude`, `longitude` (all optional) |
| `jumbo_search_products` | Search the catalog: prices, promotions, unit prices, links, SKUs. | `query` (required), `sort`, `limit` (`20`, max `30`) |
| `jumbo_get_product_recommendations` | Recommendations, alternatives, cross-sells, or weekly promotions. | `sku`, `query`, `promotions_only` (`false`) |
| `jumbo_get_promo_digest` | What's on offer among the things you actually buy (read-only). | `days` (`90`), `min_times` (`2`), `limit` (`25`), `category` |
| `jumbo_get_basket` | Current basket: lines, quantities, unit prices, promotions, subtotal. | — |
| `jumbo_get_deposits` | Statiegeld for one order: catalogue plus deposits returned. | `order_id` (required) |
| `jumbo_get_stamps` | Digital stamps, active saving (spaar) campaigns, buying-stamps balance. | — |

---

## Usage examples

```text
"Show my last 5 receipts."                     → jumbo_list_receipts
"What did I pay for milk last month?"          → jumbo_search_receipts { "query": "melk" }
"How many Extra's points do I have?"           → jumbo_get_balance
"Add eggs and milk to my shopping list."       → jumbo_add_shopping_list_items
"What's on offer that I actually buy?"         → jumbo_get_promo_digest
"Which Jumbo is closest to Utrecht?"           → jumbo_search_stores { "query": "utrecht" }
```

---

## Notes

- Prices are returned as **integer cents** (e.g. `139` = €1.39).
- The shopping-list tools are the only writes. Basket, deposits, stamps and promotion tools are read-only.
- When Jumbo rejects a call, the tool returns an error payload with Jumbo's own `reason` and `errorMessage` rather than a generic message.

---

## Local Development

```bash
git clone https://github.com/Robert-SD/jumbo-mcp.git
cd jumbo-mcp
npm install
npm run build
```

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Run the server via `tsx` |
| `npm test` | Run the unit tests (mocked HTTP, no live Jumbo calls) |
| `npm run login` | Authentication CLI |
| `npm run status` | Verify the live connection and token |
| `npm run build` | Compile TypeScript to `dist/` |

---

## License

MIT License - Copyright (c) 2026 Robert Schulze Dieckhoff
