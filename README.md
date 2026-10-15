# Jumbo MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-0.2.0-green.svg)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

A Model Context Protocol (MCP) server for **Jumbo Supermarkten**.

Connect your AI assistant (Claude Desktop, Cursor, Antigravity, OpenClaw, …) to your personal Jumbo account to read **digital receipts (*kassabonnen*)**, itemized prices and discounts, Extra's loyalty points, stores and products, and to manage your **shopping list (*lijstje*)**.

---

## Installation & Setup

Requires Node.js `>= 18`.

### 1. Clone & Build
```bash
git clone https://github.com/Robert-SD/jumbo-mcp.git
cd jumbo-mcp
npm install
npm run build
```

### 2. Authentication (One-time setup)
One-time login through Jumbo's official Auth0 page. The server stores a persistent refresh token locally in `~/.config/jumbo-mcp/tokens.json` and renews access tokens automatically.

```bash
npm run login     # opens browser; paste redirected jumbo://callbacks/... URL back
npm run status    # verify active connection and loyalty points
```

**Headless host (Docker, systemd, remote gateway):** copy `~/.config/jumbo-mcp/tokens.json` to the host, or set the environment variable directly:
```bash
JUMBO_REFRESH_TOKEN="your_refresh_token_here"
```

---

## Client Integration

### Method 1: Local Path (Recommended)
Add the compiled server to your MCP client config:

```json
{
  "mcpServers": {
    "jumbo": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/jumbo-mcp/dist/index.js"]
    }
  }
}
```

| Client | Config file |
| :--- | :--- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)<br>`%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| Cursor | `~/.cursor/mcp.json` |
| Other clients | the same `mcpServers` block |

### Method 2: Global Link (`npm link`)
Run `npm link` inside the cloned directory to register `jumbo-mcp` globally on your system:
```bash
npm link
```
Then use:
```json
{
  "mcpServers": {
    "jumbo": {
      "command": "jumbo-mcp"
    }
  }
}
```

### Method 3: Docker Deployment
A multi-stage [`Dockerfile`](Dockerfile) is included for containerized environments:

```bash
# Build Docker image
docker build -t jumbo-mcp .
```

Run with mounted credentials:
```json
{
  "mcpServers": {
    "jumbo": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "${HOME}/.config/jumbo-mcp:/root/.config/jumbo-mcp",
        "jumbo-mcp"
      ]
    }
  }
}
```

---

## Tools

| Tool | Description | Parameters |
| :--- | :--- | :--- |
| `jumbo_login` | Verify the connection and return the loyalty identity and points balance. | None |
| `jumbo_get_profile` | Loyalty profile: name, customer ID, Extra's card, receipt preferences. | None |
| `jumbo_list_receipts` | Recent receipts with timestamps, store and transaction IDs. | `page` (`0`), `page_size` (`10`, max `30`) |
| `jumbo_get_receipt_details` | Full itemized lines, unit prices, discounts, total, payment method, VAT. | `transaction_id` (required) |
| `jumbo_search_receipts` | Find items bought across recent receipts by keyword (e.g. `'havermelk'`). | `query` (required), `max_receipts` (`10`) |
| `jumbo_get_balance` | Live Extra's loyalty points balance. | None |
| `jumbo_get_shopping_list` | The shopping list: `isActive` plus every item. | None |
| `jumbo_add_shopping_list_items` | **Write.** Add free-text items (e.g. `['eieren']`); activates the list if needed. | `items` (required), `ensure_active` (`true`), `dedupe` (`true`) |
| `jumbo_remove_shopping_list_items` | **Write.** Remove items by id. | `item_ids` (required) |
| `jumbo_set_shopping_list_item_completed` | **Write.** Tick an item off or back on. | `item_id`, `completed` (both required) |
| `jumbo_set_shopping_list_active` | **Write.** Activate or deactivate the list. | `active` (required) |
| `jumbo_search_stores` | Nearby stores by city, address or coordinates: address, distance, hours. | `query`, `latitude`, `longitude` (all optional) |
| `jumbo_search_products` | Search the catalog: prices, promotions, unit prices, links, SKUs. | `query` (required), `sort`, `limit` (`20`, max `30`) |
| `jumbo_get_product_recommendations` | Recommendations, alternatives, cross-sells, or weekly promotions. | `sku`, `query`, `promotions_only` (`false`) |
| `jumbo_get_promo_digest` | What's on offer among the things you actually buy (read-only). | `days` (`90`), `min_times` (`2`), `limit` (`25`), `category` |
| `jumbo_get_basket` | Current basket: lines, quantities, unit prices, promotions, subtotal. | None |
| `jumbo_get_deposits` | Statiegeld for one order: catalogue plus deposits returned. | `order_id` (required) |
| `jumbo_get_stamps` | Digital stamps, active saving (spaar) campaigns, buying-stamps balance. | None |

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

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Run the server via `tsx` (development mode) |
| `npm test` | Run the unit tests (mocked HTTP, no live Jumbo calls) |
| `npm run login` | Authentication CLI wizard |
| `npm run status` | Verify the live connection and token status |
| `npm run build` | Compile TypeScript to `dist/` |

---

## License

MIT License - Copyright (c) 2026 Robert Schulze Dieckhoff
