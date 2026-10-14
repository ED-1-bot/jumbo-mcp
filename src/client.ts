import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getValidAccessToken, refreshTokens } from "./auth.js";
import {
  LoyaltyProfile,
  ReceiptDetails,
  ReceiptItem,
  ReceiptOverviewItem,
} from "./types.js";

const GRAPHQL_URL = "https://www.jumbo.com/api/graphql";

export class JumboClient {
  private userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await getValidAccessToken();
    if (token) {
      return { Authorization: `Bearer ${token}` };
    }

    // Cookie fallback
    let cookie = process.env.JUMBO_COOKIE;
    if (!cookie) {
      const cookieFile =
        process.env.JUMBO_COOKIE_FILE ||
        path.join(os.homedir(), ".config", "jumbo-mcp", "cookie.txt");
      if (fs.existsSync(cookieFile)) {
        try {
          cookie = fs.readFileSync(cookieFile, "utf-8").trim();
        } catch {
          // Ignore
        }
      }
    }

    if (cookie) {
      return { Cookie: cookie };
    }

    throw new Error(
      "Not authenticated with Jumbo. Please run 'jumbo-mcp login' or set JUMBO_TOKEN / JUMBO_COOKIE."
    );
  }

  async executeGraphql<T = any>(
    query: string,
    variables?: Record<string, any>,
    clientName: string = "JUMBO_WEB-loyalty",
    retryOn401: boolean = true
  ): Promise<T> {
    const authHeaders = await this.getAuthHeaders();
    const payload: { query: string; variables?: Record<string, any> } = { query };
    if (variables) payload.variables = variables;

    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      "Content-Type": "application/json",
      Accept: "application/json",
      "apollographql-client-name": clientName,
      "apollographql-client-version": "master-v39.2.0-web",
      "x-source": clientName,
      ...authHeaders,
    };

    let resp: Response;
    try {
      resp = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
      throw new Error(`Network error calling Jumbo GraphQL API: ${err.message}`);
    }

    if (resp.status === 401 && retryOn401) {
      try {
        await refreshTokens();
        return this.executeGraphql<T>(query, variables, clientName, false);
      } catch {
        // Fall through
      }
      throw new Error("HTTP 401 Unauthorized: Session or token expired.");
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Jumbo API error (HTTP ${resp.status}): ${errBody}`);
    }

    const res = (await resp.json()) as any;
    if (res.errors && res.errors.length > 0) {
      const errMsgs = res.errors.map((e: any) => e.message || "Unknown error").join("; ");
      if (
        (errMsgs.includes("401 UNAUTHORIZED") || errMsgs.includes("Customer ID")) &&
        retryOn401
      ) {
        try {
          await refreshTokens();
          return this.executeGraphql<T>(query, variables, clientName, false);
        } catch {
          // Ignore
        }
        throw new Error(
          "Jumbo session expired. Please re-authenticate by running 'jumbo-mcp login'."
        );
      }
      throw new Error(`GraphQL Error: ${errMsgs}`);
    }

    return res.data as T;
  }

  parseReceiptDoc(rawImageStr: string): {
    items: ReceiptItem[];
    total: number | null;
    payment_method: string | null;
    vat_overview: string[];
    raw_lines: string[];
  } {
    try {
      const data = JSON.parse(rawImageStr);
      const doc = data.documents[0].documents[0];

      const lines: string[] = [];
      for (const sec of doc.printSections || []) {
        for (const obj of sec.textObjects || []) {
          for (const tl of obj.textLines || []) {
            const t = (tl.texts || []).map((seg: any) => seg.text || "").join("");
            if (t.trim()) lines.push(t);
          }
        }
      }

      const items: ReceiptItem[] = [];
      let inItems = false;
      let total: number | null = null;
      let paymentMethod: string | null = null;
      const vatLines: string[] = [];
      let inVat = false;

      for (const line of lines) {
        if (line.includes("OMSCHRIJVING")) {
          inItems = true;
          continue;
        }

        if (inItems) {
          if (line.startsWith("Totaal")) {
            const m = line.match(/Totaal\s+([\d,]+)/);
            if (m) total = parseFloat(m[1].replace(",", "."));
            inItems = false;
            continue;
          }

          const m = line.match(/^(.*?)(?:\s+P)?\s+(-?[\d]+,[\d]{2})$/);
          if (m) {
            const name = m[1].trim();
            const price = parseFloat(m[2].replace(",", "."));
            const isPromo = line.includes(" P ") || line.endsWith(" P") || line.includes("  P  ");
            items.push({ name, price, is_promotion: isPromo });
          }
        }

        if (line.startsWith("Betaald:") || line.startsWith("VISA") || line.startsWith("PIN")) {
          if (!paymentMethod && !line.startsWith("Betaald:")) {
            paymentMethod = line.trim();
          }
        }

        if (line.includes("BTW overzicht")) {
          inVat = true;
        } else if (inVat) {
          if (line.includes("Totaal")) {
            inVat = false;
          } else if (line.trim()) {
            vatLines.push(line.trim());
          }
        }
      }

      return {
        items,
        total,
        payment_method: paymentMethod,
        vat_overview: vatLines,
        raw_lines: lines,
      };
    } catch {
      return {
        items: [],
        total: null,
        payment_method: null,
        vat_overview: [],
        raw_lines: [],
      };
    }
  }

  async getProfile(): Promise<LoyaltyProfile> {
    const q = `
    query GetProfile {
      getProfile {
        customerId
        name { givenName }
        loyaltyCard { number }
        checkoutPreferences { printReceipt promotionStamps }
        digitalStamps { optIn }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    const prof = data?.getProfile || {};
    return {
      name: prof.name?.givenName || "",
      customer_id: prof.customerId || "",
      loyalty_card_number: prof.loyaltyCard?.number || "",
      digital_receipt_enabled: prof.checkoutPreferences?.printReceipt === false,
      digital_stamps_opt_in: Boolean(prof.digitalStamps?.optIn),
    };
  }

  async listReceipts(
    page: number = 0,
    pageSize: number = 10
  ): Promise<{
    total_results: number;
    page: number;
    page_size: number;
    receipts: ReceiptOverviewItem[];
  }> {
    const q = `
    query GetReceiptOverview {
      receiptOverview(page: ${page}, pageSize: ${pageSize}) {
        totalResults
        pageSize
        currentPage
        receipts {
          transactionId
          purchaseEndOn
          receiptSource
          store {
            storeId
            name
          }
          pointBalance
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-orders");
    const overview = data?.receiptOverview || {};
    const receipts: ReceiptOverviewItem[] = (overview.receipts || []).map((r: any) => ({
      transaction_id: r.transactionId,
      datetime: r.purchaseEndOn,
      store: r.store?.name,
      store_id: r.store?.storeId,
      points_earned: r.pointBalance,
    }));

    return {
      total_results: overview.totalResults,
      page: overview.currentPage,
      page_size: overview.pageSize,
      receipts,
    };
  }

  async getReceiptDetails(transactionId: string): Promise<ReceiptDetails> {
    const q = `
    query GetDigitalReceipt {
      getDigitalReceipt(transactionId: "${transactionId}") {
        transactionId
        purchaseEndOn
        receiptSource
        store {
          storeId
          name
        }
        pointBalance
        image
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-orders");
    const receipt = data?.getDigitalReceipt;
    if (!receipt) {
      throw new Error(`Receipt not found for transactionId: ${transactionId}`);
    }

    const parsed = this.parseReceiptDoc(receipt.image || "{}");
    return {
      transaction_id: receipt.transactionId,
      datetime: receipt.purchaseEndOn,
      store: receipt.store?.name,
      store_id: receipt.store?.storeId,
      points_earned: receipt.pointBalance,
      total: parsed.total,
      payment_method: parsed.payment_method,
      items_count: parsed.items.length,
      items: parsed.items,
      vat_overview: parsed.vat_overview,
      raw_lines: parsed.raw_lines,
    };
  }

  async searchReceipts(
    query: string,
    maxReceipts: number = 10
  ): Promise<{
    query: string;
    receipts_scanned: number;
    matches: Array<{
      datetime: string;
      store: string;
      transaction_id: string;
      matched_items: ReceiptItem[];
    }>;
  }> {
    const overview = await this.listReceipts(0, maxReceipts);
    const matches: Array<{
      datetime: string;
      store: string;
      transaction_id: string;
      matched_items: ReceiptItem[];
    }> = [];
    const qLower = query.toLowerCase();

    for (const r of overview.receipts) {
      if (!r.transaction_id) continue;
      try {
        const details = await this.getReceiptDetails(r.transaction_id);
        const matchingItems = details.items.filter((it) =>
          it.name.toLowerCase().includes(qLower)
        );
        if (matchingItems.length > 0) {
          matches.push({
            datetime: details.datetime,
            store: details.store,
            transaction_id: r.transaction_id,
            matched_items: matchingItems,
          });
        }
      } catch {
        continue;
      }
    }

    return {
      query,
      receipts_scanned: overview.receipts.length,
      matches,
    };
  }

  async getBalance(): Promise<{ balance: number }> {
    const q = `
    query GetBalance {
      getBalance {
        balance
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    return data?.getBalance || { balance: 0 };
  }

  async getShoppingList(): Promise<{ isActive: boolean; items: Array<{ id: string }> }> {
    const q = `
    query GetShoppingList {
      shoppingList {
        ... on ShoppingList {
          isActive
          items {
            id
          }
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    return data?.shoppingList || { isActive: false, items: [] };
  }
}
