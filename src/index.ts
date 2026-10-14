#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as dotenv from "dotenv";
import { JumboClient } from "./client.js";
import {
  decodeJwtPayload,
  getTokensFilePath,
  loadTokens,
  loginCli,
} from "./auth.js";

// Load local .env if present
dotenv.config();

const client = new JumboClient();

async function showStatus(): Promise<void> {
  const tokens = loadTokens();
  if (!tokens) {
    console.log("❌ Not logged in. No tokens found.");
    console.log(`Expected tokens at: ${getTokensFilePath()}`);
    console.log("\nRun 'npx jumbo-mcp login' to authenticate.");
    return;
  }

  console.log("=" .repeat(60));
  console.log("📋 JUMBO MCP STATUS");
  console.log("=" .repeat(60));
  console.log(`Token storage: ${getTokensFilePath()}`);

  const hasRefresh = Boolean(tokens.refresh_token);
  console.log(`Refresh Token: ${hasRefresh ? "✅ Active (Permanent)" : "❌ Missing"}`);
  console.log(`Last Saved:    ${tokens.saved_at || "Unknown"}`);

  const claims = decodeJwtPayload(tokens.access_token);
  if (claims) {
    console.log(`Customer ID:   ${claims["https://jumbo.com/customerId"] || "Unknown"}`);
    console.log(`Account:       ${claims["https://jumbo.com/username"] || "Unknown"}`);
  }

  console.log("\nVerifying live API connection...");
  try {
    const prof = await client.getProfile();
    console.log(`Loyalty Name:  ${prof.name}`);
    console.log(`Card Number:   ${prof.loyalty_card_number}`);
    const bal = await client.getBalance();
    console.log(`Points:        ${bal.balance}`);
    console.log("✅ Connection healthy and operational!");
  } catch (err: any) {
    console.log(`⚠️ Live check failed: ${err.message}`);
  }
}

async function startServer(): Promise<void> {
  const server = new McpServer({
    name: "jumbo-mcp",
    version: "1.0.0",
  });

  // Tool: Get Profile
  server.tool(
    "jumbo_get_profile",
    "Get customer loyalty profile, name, customer ID, Extra's card details, and digital receipt preferences.",
    {},
    async () => {
      try {
        const profile = await client.getProfile();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(profile, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: List Receipts
  server.tool(
    "jumbo_list_receipts",
    "List recent Jumbo supermarket store receipts (kassabonnen) with date, store location, and transaction ID.",
    {
      page: z.number().int().min(0).default(0).describe("Page number (default 0)"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(10)
        .describe("Number of receipts to return (default 10)"),
    },
    async ({ page, page_size }) => {
      try {
        const receipts = await client.listReceipts(page, page_size);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(receipts, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Get Receipt Details
  server.tool(
    "jumbo_get_receipt_details",
    "Get detailed line items, unit prices, discounts, total, payment method, and Extra's points for a specific Jumbo receipt.",
    {
      transaction_id: z
        .string()
        .describe("The transactionId of the receipt (from jumbo_list_receipts)"),
    },
    async ({ transaction_id }) => {
      try {
        const details = await client.getReceiptDetails(transaction_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(details, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Search Receipts
  server.tool(
    "jumbo_search_receipts",
    "Search for specific grocery items purchased across recent Jumbo receipts by keyword (e.g. 'havermelk', 'bio ei', 'skyr').",
    {
      query: z.string().describe("Product keyword to search for"),
      max_receipts: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(10)
        .describe("Maximum number of recent receipts to inspect (default 10)"),
    },
    async ({ query, max_receipts }) => {
      try {
        const results = await client.searchReceipts(query, max_receipts);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Get Balance
  server.tool(
    "jumbo_get_balance",
    "Get customer's live Jumbo Extra's loyalty points balance.",
    {},
    async () => {
      try {
        const balance = await client.getBalance();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(balance, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Get Shopping List
  server.tool(
    "jumbo_get_shopping_list",
    "Get the user's current active Jumbo shopping list.",
    {},
    async () => {
      try {
        const list = await client.getShoppingList();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(list, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0]?.toLowerCase();

  if (cmd === "login") {
    await loginCli("prod");
  } else if (cmd === "status") {
    await showStatus();
  } else {
    await startServer();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
