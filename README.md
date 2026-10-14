# Jumbo MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-1.0.0-green.svg)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

A Model Context Protocol (MCP) server for **Jumbo Supermarkten**.

This server enables AI assistants (Claude Desktop, Cursor, Antigravity, OpenClaw, etc.) to securely access your personal Jumbo account to fetch **digital store receipts (*kassabonnen*)**, itemized prices, discounts, Extra's loyalty points balance, and active shopping lists.

---

## Authentication

`jumbo-mcp` implements the official Jumbo mobile app Auth0 PKCE flow:
* **One-time Login:** Authenticate once via the official Jumbo login page.
* **Refresh Token:** Auth0 issues a persistent refresh token stored securely on your local machine.
* **Automatic Refresh:** The server automatically refreshes access tokens in the background as needed.

---

## Features & Tools

| Tool | Description | Parameters |
| :--- | :--- | :--- |
| `jumbo_get_profile` | Get customer loyalty profile, name, customer ID, Extra's card details, and digital receipt preferences. | None |
| `jumbo_list_receipts` | List recent store receipts (*kassabonnen*) with timestamps, store location, and transaction IDs. | `page` (default: `0`), `page_size` (default: `10`, max: `30`) |
| `jumbo_get_receipt_details` | Retrieve full itemized line items, unit prices, discounts, total, payment method, and VAT breakdown for a specific receipt. | `transaction_id` (required) |
| `jumbo_search_receipts` | Search for specific grocery items purchased across recent receipts by keyword (e.g. `'havermelk'`, `'bio ei'`, `'skyr'`). | `query` (required), `max_receipts` (default: `10`) |
| `jumbo_get_balance` | Get live Jumbo Extra's loyalty points balance. | None |
| `jumbo_get_shopping_list` | Retrieve the customer's active shopping list items. | None |
| `jumbo_search_stores` | Search nearby Jumbo supermarket stores by city, address, or geographic coordinates (latitude, longitude). Returns address, distance, opening hours, and facilities. | `query` (optional), `latitude` (optional), `longitude` (optional) |
| `jumbo_get_product_recommendations` | Get product recommendations, alternatives, and cross-sell suggestions by SKU or search keyword, or retrieve current weekly promotional recommendations. | `sku` (optional), `query` (optional), `promotions_only` (optional, default: `false`) |

---

## Quickstart

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
  JUMBO_REFRESH_TOKEN="v1.MVxY..."
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
* `npm run login`: Run authentication CLI
* `npm run status`: Verify live API connection and token status
* `npm run build`: Compile TypeScript to `dist/`

---

## Postman Collection

A Postman collection is included in [`postman/jumbo.postman_collection.json`](postman/jumbo.postman_collection.json).

It covers over 200 Jumbo GraphQL operations and REST endpoints extracted from the mobile application:
* Digital receipts and purchase history
* Product catalog search and alternatives
* Extra's loyalty balance and profile details
* Store locator and opening hours
* Active shopping lists and checkout sessions

To use it in Postman, import the JSON file and set the `token` variable to your Auth0 access token.

---

## License

MIT License - Copyright (c) 2026 Robert Schulze Dieckhoff
