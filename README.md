# Jumbo MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-0.1.0-green.svg)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

A Model Context Protocol (MCP) server for **Jumbo Supermarkten**.

This server enables AI assistants (Claude Desktop, Cursor, Antigravity, OpenClaw, etc.) to securely access your personal Jumbo account to fetch **digital store receipts (*kassabonnen*)**, itemized prices, discounts, Extra's loyalty points balance, and to read and **write your shopping list (*lijstje*)**.

---

## Authentication

`jumbo-mcp` implements the Auth0 PKCE flow:
* **One-time Login:** Authenticate once via the official Jumbo login page.
* **Refresh Token:** Auth0 issues a persistent refresh token stored securely on your local machine.
* **Automatic Refresh:** The server automatically refreshes access tokens in the background as needed.

---

## Features & Tools

| Tool | Description | Parameters |
| :--- | :--- | :--- |
| `jumbo_login` | Verify active connection and authentication status with Jumbo. Returns loyalty user identity and points balance. | None |
| `jumbo_get_profile` | Get customer loyalty profile, name, customer ID, Extra's card details, and digital receipt preferences. | None |
| `jumbo_list_receipts` | List recent store receipts (*kassabonnen*) with timestamps, store location, and transaction IDs. | `page` (default: `0`), `page_size` (default: `10`, max: `30`) |
| `jumbo_get_receipt_details` | Retrieve full itemized line items, unit prices, discounts, total, payment method, and VAT breakdown for a specific receipt. | `transaction_id` (required) |
| `jumbo_search_receipts` | Search for specific grocery items purchased across recent receipts by keyword (e.g. `'havermelk'`, `'bio ei'`, `'skyr'`). | `query` (required), `max_receipts` (default: `10`) |
| `jumbo_get_balance` | Get live Jumbo Extra's loyalty points balance. | None |
| `jumbo_get_shopping_list` | Retrieve the customer's shopping list: `isActive` plus every item (`id`, `term`, `sku`, `completed`). | None |
| `jumbo_add_shopping_list_items` | **Write.** Add one or more free-text items to the shopping list (e.g. `['eieren']`). Activates the list first when it is inactive (unless `ensure_active` is `false`). | `items` (required, `string[]`), `ensure_active` (default: `true`) |
| `jumbo_set_shopping_list_active` | **Write.** Activate or deactivate the shopping list. Adds/removes no items. | `active` (required, `boolean`) |
| `jumbo_search_stores` | Search nearby Jumbo supermarket stores by city, address, or geographic coordinates (latitude, longitude). Returns address, distance, opening hours, and facilities. | `query` (optional), `latitude` (optional), `longitude` (optional) |
| `jumbo_search_products` | Search the entire Jumbo supermarket grocery catalog by keyword. Returns matching products, current prices, promotional discounts, unit prices, product links, and SKUs. | `query` (required), `sort` (optional: `'PRICE_ASC'` or `'PRICE_DESC'`), `limit` (default: `20`, max: `30`) |
| `jumbo_get_product_recommendations` | Get product recommendations, alternatives, and cross-sell suggestions by SKU or search keyword, or retrieve current weekly promotional recommendations. | `sku` (optional), `query` (optional), `promotions_only` (optional, default: `false`) |

---

## Shopping list (write)

The shopping list is the only write surface. Basket, checkout, order and payment operations are deliberately **not** implemented.

### `jumbo_add_shopping_list_items`

| | |
| :--- | :--- |
| GraphQL | `mutation EditShoppingListItems($input: EditShoppingListItemsInput!)` |
| Input | `{ input: { items: [{ term: string, completed?: boolean, sku?: string, id?: string }] } }` |
| Parameters | `items: string[]` (required, 1+ non-empty terms), `ensure_active?: boolean` (default `true`) |
| Returns | `{ status: "ok", is_active, activated_first, added: ShoppingListItem[] }`. `added` is the API's echo of the items the mutation accepted — not a second read. |

Behaviour:
1. If `ensure_active` is true and the list is inactive, it calls `toggleShoppingList({ active: true })` first, then adds. `activated_first` reports whether that happened.
2. Sends the trimmed terms as `{ term, completed: false }` — matching the app's own add payload (`[{ term, completed: false }]`).
3. Then re-reads the list solely to report the current `is_active`. `added` is **the mutation's own echo** of the items it accepted (the API's response to `editShoppingListItems`), not a re-read of the list.

> The `EditShoppingListItemsInput` / `ToggleShoppingListInput` field shapes (`{ items: [{ term, completed }] }`, `{ active }`) are **inferred** from the app's client-side call sites. The APK teardown confirms the operation names and the `ShoppingListItem` fragment fields, but not these input types. The first live call is the smoke test.

### `jumbo_set_shopping_list_active`

| | |
| :--- | :--- |
| GraphQL | `mutation toggleShoppingList($input: ToggleShoppingListInput!)` |
| Input | `{ input: { active: boolean } }` |
| Parameters | `active: boolean` (required) |
| Returns | `{ status: "ok", is_active }` |

### Failure modes

The API returns shopping-list failures as a **union member** (`ShoppingListError`) inside an HTTP 200 response — not as a GraphQL top-level error. The client branches on `__typename` and raises `JumboShoppingListError`, and the tool returns it as a structured `isError` payload with the API's own values:

```json
{
  "status": "error",
  "error": "ShoppingListError",
  "reason": "LIST_INACTIVE",
  "errorMessage": "Shopping list is not active"
}
```

A mutation is **never** reported as success unless it returned `EditShoppingListItemsResult` / `ShoppingListState`. An unexpected union member raises `UNEXPECTED_RESULT`. Credentials are never echoed into any error text.

### Auth expectations

Writes reuse the **existing** Auth0 session (the same `Authorization: Bearer <access token>` path as the read tools, refreshed on 401). No separate credential, scope or login flow is required. Reads use the `JUMBO_WEB-loyalty` client, matching where the app issues these mutations.

---

### 1. Prerequisites
- Node.js `>= 18.0.0`
- A personal Jumbo account ([jumbo.com](https://www.jumbo.com))

### 2. Authentication (One-time setup)

Run the login wizard:

```bash
npx jumbo-mcp login
```

1. The CLI will open your default browser to Jumbo's official login screen.
2. Sign in with your Jumbo email and password.
3. After logging in, your browser will attempt to redirect to `jumbo://callbacks/login?code=...`.
4. Copy that URL from your browser address bar and paste it into the terminal prompt.
5. Done! Your permanent refresh token is saved securely to `~/.config/jumbo-mcp/tokens.json`.

You can verify your connection at any time:
```bash
npx jumbo-mcp status
```

---

## Client Integration

### Claude Desktop
Add this to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "jumbo": {
      "command": "npx",
      "args": ["-y", "jumbo-mcp"]
    }
  }
}
```

### Cursor
Add to your Cursor settings (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "jumbo": {
      "command": "npx",
      "args": ["-y", "jumbo-mcp"]
    }
  }
}
```

### Headless Server / Docker Deployment
If hosting on a remote server (e.g. Docker, systemd, or remote gateway):
* Copy your `~/.config/jumbo-mcp/tokens.json` to the server, OR
* Pass the environment variable directly:
  ```bash
  JUMBO_REFRESH_TOKEN="your_refresh_token_here"
  ```

---

## Local Development & Building

```bash
git clone https://github.com/Robert-SD/jumbo-mcp.git
cd jumbo-mcp
npm install
npm run build
```

* `npm run dev`: Run server directly via `tsx`
* `npm test`: Run unit tests (mocked HTTP layer, no live Jumbo calls)
* `npm run login`: Run authentication CLI
* `npm run status`: Verify live API connection and token status
* `npm run build`: Compile TypeScript to `dist/`


---

## License

MIT License - Copyright (c) 2026 Robert Schulze Dieckhoff
