import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getValidAccessToken, refreshTokens } from "./auth.js";
import {
  LoyaltyProfile,
  ReceiptDetails,
  ReceiptItem,
  ReceiptOverviewItem,
  StoreInfo,
  ProductRecommendationsResult,
  RecommendedProduct,
  ProductSearchItem,
  ProductSearchResult,
  ShoppingList,
  ShoppingListItem,
  ShoppingListItemInput,
  EditShoppingListItemsInput,
  Basket,
  DepositsResult,
  StampsResult,
  PromoDigest,
  PromoDigestEntry,
  DigestPromotion,
  DigestAccountOffer,
} from "./types.js";

const GRAPHQL_URL = "https://www.jumbo.com/api/graphql";

/**
 * Raised when a shopping-list mutation returns the `ShoppingListError` union
 * member. Carries the API's `reason` and `errorMessage` verbatim so callers (and
 * the MCP tool layer) can surface them instead of reporting a false success.
 */
/**
 * Generic union error. Jumbo's write/read unions return their failure member as
 * a *successful* GraphQL response (HTTP 200, no top-level `errors`), so callers
 * must branch on `__typename` and raise. Carries the API's own values.
 */
export class JumboApiError extends Error {
  readonly typename: string;
  readonly reason: string;
  readonly errorMessage: string;

  constructor(typename: string, reason: string, errorMessage: string) {
    super(`Jumbo ${typename} [${reason}]: ${errorMessage}`);
    this.name = "JumboApiError";
    this.typename = typename;
    this.reason = reason;
    this.errorMessage = errorMessage;
  }
}

export class JumboShoppingListError extends JumboApiError {
  constructor(reason: string, errorMessage: string) {
    super("ShoppingListError", reason, errorMessage);
    this.name = "JumboShoppingListError";
  }
}

/**
 * Raised when Jumbo rejects the token we sent (as opposed to never having one),
 * i.e. the session is genuinely no longer valid for the Jumbo API. Carries the
 * upstream text for diagnosis but always leads with an actionable instruction.
 */
export class JumboSessionInvalidError extends Error {
  readonly code = "JUMBO_SESSION_INVALID";

  constructor(upstreamDetail: string) {
    const detail = upstreamDetail.trim().slice(0, 200);
    super(
      "Jumbo rejected the current session: the token was accepted by Auth0 but " +
        "Jumbo's API could not resolve a customer from it. Run 'jumbo-mcp login' to " +
        "re-authenticate (for headless deployments, set JUMBO_REFRESH_TOKEN from that " +
        "login)." +
        (detail ? ` [upstream: ${detail}]` : "")
    );
    this.name = "JumboSessionInvalidError";
  }
}

export class JumboClient {
  private userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

  private async getAuthHeaders(accessTokenOverride?: string): Promise<Record<string, string>> {
    // An explicit override (a token we just refreshed) must win over the stored
    // session and over JUMBO_TOKEN; otherwise refresh+retry re-sends the very
    // token that just failed, and the retry can never succeed.
    const token =
      accessTokenOverride !== undefined
        ? accessTokenOverride
        : await getValidAccessToken();
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
    retryOn401: boolean = true,
    accessTokenOverride?: string
  ): Promise<T> {
    const authHeaders = await this.getAuthHeaders(accessTokenOverride);
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
      // `await` the retry: without it the recursive failure resolves the
      // returned promise asynchronously, escapes this try/catch, and surfaces to
      // the caller as a raw transport error instead of an actionable one.
      const fresh = await refreshTokens();
      return await this.executeGraphql<T>(
        query,
        variables,
        clientName,
        false,
        fresh.access_token
      );
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Jumbo API error (HTTP ${resp.status}): ${errBody}`);
    }

    const res = (await resp.json()) as any;
    if (res.errors && res.errors.length > 0) {
      const errMsgs = res.errors.map((e: any) => e.message || "Unknown error").join("; ");
      const isAuthFailure =
        errMsgs.includes("401 UNAUTHORIZED") ||
        errMsgs.includes("Customer ID") ||
        /unauthorized/i.test(errMsgs);

      if (isAuthFailure && retryOn401) {
        // Renew once, then replay with the NEW token explicitly. If this still
        // fails the session is genuinely dead -- say so, don't leak raw text.
        const fresh = await refreshTokens();
        return await this.executeGraphql<T>(
          query,
          variables,
          clientName,
          false,
          fresh.access_token
        );
      }

      if (isAuthFailure) {
        throw new JumboSessionInvalidError(errMsgs);
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
    query GetDigitalReceipt($transactionId: String) {
      receipt(transactionId: $transactionId) {
        receiptImage {
          image
          type
          receiptPoints {
            earned
            newBalance
            oldBalance
            redeemed
          }
        }
        store {
          name
          location {
            address {
              city
              houseNumber
              postalCode
              street
            }
          }
        }
        purchaseEndOn
        receiptSource
        customerDetails {
          customerId
          loyaltyCard {
            number
          }
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(
      q,
      { transactionId },
      "JUMBO_WEB-orders"
    );
    const receipt = data?.receipt;
    if (!receipt) {
      throw new Error(`Receipt not found for transactionId: ${transactionId}`);
    }

    const rawImage = receipt.receiptImage?.image || "{}";
    const parsed = this.parseReceiptDoc(rawImage);
    return {
      transaction_id: transactionId,
      datetime: receipt.purchaseEndOn || "",
      store: receipt.store?.name || "",
      store_id: "",
      points_earned: receipt.receiptImage?.receiptPoints?.earned ?? null,
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

  /**
   * The GraphQL unions return `ShoppingListError` as a *successful* response
   * (no top-level `errors`), so a mutation that failed semantically still looks
   * like a 200. Always branch on `__typename` and raise, never swallow.
   */
  private raiseIfShoppingListError(value: any, operation: string): void {
    if (value && value.__typename === "ShoppingListError") {
      throw new JumboShoppingListError(
        value.reason || "UNKNOWN",
        value.errorMessage || `Jumbo rejected ${operation}.`
      );
    }
  }

  private mapShoppingListItems(raw: any[]): ShoppingListItem[] {
    return (raw || []).map((i: any) => ({
      id: i.id ?? null,
      term: i.term ?? "",
      sku: i.sku ?? null,
      completed: Boolean(i.completed),
    }));
  }

  async getShoppingList(): Promise<ShoppingList> {
    const q = `
    query GetShoppingList {
      shoppingList {
        __typename
        ... on ShoppingList {
          isActive
          items {
            id
            term
            sku
            completed
          }
        }
        ... on ShoppingListError {
          reason
          errorMessage
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    const list = data?.shoppingList;
    this.raiseIfShoppingListError(list, "reading the shopping list");
    return {
      isActive: Boolean(list?.isActive),
      items: this.mapShoppingListItems(list?.items),
    };
  }

  /**
   * Add or edit shopping-list items via `mutation EditShoppingListItems`.
   * Returns the resulting item set as echoed by the API.
   */
  async editShoppingListItems(
    input: EditShoppingListItemsInput
  ): Promise<ShoppingListItem[]> {
    if (!input.items || input.items.length === 0) {
      throw new Error("editShoppingListItems requires at least one item.");
    }
    const q = `
    mutation EditShoppingListItems($input: EditShoppingListItemsInput!) {
      editShoppingListItems(input: $input) {
        __typename
        ... on EditShoppingListItemsResult {
          items {
            id
            term
            sku
            completed
          }
        }
        ... on ShoppingListError {
          reason
          errorMessage
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, { input }, "JUMBO_WEB-loyalty");
    const result = data?.editShoppingListItems;
    this.raiseIfShoppingListError(result, "editing shopping-list items");
    if (result?.__typename !== "EditShoppingListItemsResult") {
      throw new JumboShoppingListError(
        "UNEXPECTED_RESULT",
        `Unexpected result type '${result?.__typename ?? "null"}' from editShoppingListItems.`
      );
    }
    return this.mapShoppingListItems(result.items);
  }

  /**
   * Convenience wrapper for the common "add eggs" case: one or more free-text
   * terms, optionally auto-activating an inactive list first.
   */
  async addShoppingListItems(
    terms: string[],
    options?: {
      sku?: string | null;
      completed?: boolean;
      ensureActive?: boolean;
      /** Skip terms already on the list (case-insensitive, trimmed). Default true. */
      dedupe?: boolean;
    }
  ): Promise<{
    isActive: boolean;
    added: ShoppingListItem[];
    activated: boolean;
    skipped: string[];
  }> {
    const cleaned = (terms || [])
      .map((t) => String(t).trim())
      .filter((t) => t.length > 0);
    if (cleaned.length === 0) {
      throw new Error("addShoppingListItems requires at least one non-empty term.");
    }

    const ensureActive = options?.ensureActive ?? true;
    const dedupe = options?.dedupe ?? true;

    const before = await this.getShoppingList();
    let activated = false;
    if (ensureActive && !before.isActive) {
      await this.setShoppingListActive(true);
      activated = true;
    }

    const existing = new Set(before.items.map((i) => i.term.trim().toLowerCase()));
    const skipped: string[] = [];
    const toAdd: string[] = [];
    for (const term of cleaned) {
      const key = term.toLowerCase();
      const alreadyThere =
        existing.has(key) || toAdd.some((t) => t.toLowerCase() === key);
      if (dedupe && alreadyThere) {
        skipped.push(term);
        continue;
      }
      toAdd.push(term);
    }

    const added = toAdd.length
      ? await this.editShoppingListItems({
          items: toAdd.map((term) => ({
            term,
            ...(options?.sku ? { sku: options.sku } : {}),
            completed: options?.completed ?? false,
          })),
        })
      : [];

    const list = await this.getShoppingList();
    return { isActive: list.isActive, added, activated, skipped };
  }

  /** Activate/deactivate the shopping list via `mutation toggleShoppingList`. */
  async setShoppingListActive(active: boolean): Promise<boolean> {
    const q = `
    mutation toggleShoppingList($input: ToggleShoppingListInput!) {
      toggleShoppingList(input: $input) {
        __typename
        ... on ShoppingListState {
          isActive
        }
        ... on ShoppingListError {
          reason
          errorMessage
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(
      q,
      { input: { active } },
      "JUMBO_WEB-loyalty"
    );
    const result = data?.toggleShoppingList;
    this.raiseIfShoppingListError(result, "toggling the shopping list");
    if (result?.__typename !== "ShoppingListState") {
      throw new JumboShoppingListError(
        "UNEXPECTED_RESULT",
        `Unexpected result type '${result?.__typename ?? "null"}' from toggleShoppingList.`
      );
    }
    return Boolean(result.isActive);
  }

  async searchStores(options?: {
    query?: string;
    latitude?: number;
    longitude?: number;
  }): Promise<{
    searched_location: { latitude: string; longitude: string };
    total_found: number;
    stores: StoreInfo[];
  }> {
    const coords = await resolveCoordinates(
      options?.query,
      options?.latitude,
      options?.longitude
    );

    const q = `
    query GetStoreList($input: StoresByCoordinatesInput!) {
      storesByCoordinates(input: $input) {
        stores {
          storeId
          name
          distance
          location {
            address {
              street
              houseNumber
              city
              postalCode
            }
          }
          openingHours {
            monday { opensAt closesAt }
            tuesday { opensAt closesAt }
            wednesday { opensAt closesAt }
            thursday { opensAt closesAt }
            friday { opensAt closesAt }
            saturday { opensAt closesAt }
            sunday { opensAt closesAt }
          }
          facilities {
            locationType
          }
        }
        totalCount
      }
    }
    `;

    const data = await this.executeGraphql<any>(
      q,
      { input: { latitude: coords.lat, longitude: coords.lon } },
      "JUMBO_WEB-loyalty"
    );

    const rawStores = data?.storesByCoordinates?.stores || [];
    const stores: StoreInfo[] = rawStores.map((s: any) => ({
      storeId: s.storeId,
      name: s.name,
      distanceKm: s.distance ? parseFloat(s.distance) : null,
      address: {
        street: s.location?.address?.street,
        houseNumber: s.location?.address?.houseNumber,
        city: s.location?.address?.city,
        postalCode: s.location?.address?.postalCode,
      },
      openingHours: s.openingHours,
      locationType: s.facilities?.locationType,
    }));

    return {
      searched_location: { latitude: coords.lat, longitude: coords.lon },
      total_found: data?.storesByCoordinates?.totalCount ?? stores.length,
      stores,
    };
  }

  async getProductRecommendations(options?: {
    sku?: string;
    query?: string;
    promotionsOnly?: boolean;
  }): Promise<ProductRecommendationsResult> {
    const promotionsOnly = options?.promotionsOnly ?? false;

    if (promotionsOnly || (!options?.sku && !options?.query)) {
      const promoQ = `
      query getPromotions {
        promotionTab(id: "actieprijs") {
          runtimes {
            sections {
              promotions {
                products {
                  title
                  sku
                  price { price promoPrice }
                }
              }
            }
          }
        }
      }
      `;
      const data = await this.executeGraphql<any>(promoQ, {}, "JUMBO_WEB-loyalty");
      const proms: RecommendedProduct[] = [];
      const runtimes = data?.promotionTab?.runtimes || [];
      for (const rt of runtimes) {
        for (const sec of rt.sections || []) {
          for (const p of sec.promotions || []) {
            for (const pr of p.products || []) {
              if (pr && pr.sku) {
                proms.push({
                  sku: pr.sku,
                  title: pr.title,
                  price: pr.price ? { price: pr.price.price, promoPrice: pr.price.promoPrice } : null,
                });
              }
            }
          }
        }
      }
      return {
        alternatives: [],
        promotions: proms.slice(0, 15),
      };
    }

    let targetSku = options?.sku;
    let sourceProduct: RecommendedProduct | undefined;

    if (!targetSku && options?.query) {
      const searchQ = `
      query SearchProductsByKeyword($input: ProductSearchInput!) {
        searchProducts(input: $input) {
          products {
            title
            sku
            price { price promoPrice }
            promotions { tags { text } }
          }
        }
      }
      `;
      const searchRes = await this.executeGraphql<any>(
        searchQ,
        { input: { searchType: "KEYWORD", searchTerms: options.query } },
        "JUMBO_WEB-loyalty"
      );
      const found = searchRes?.searchProducts?.products || [];
      if (found.length > 0) {
        targetSku = found[0].sku;
        sourceProduct = {
          sku: found[0].sku,
          title: found[0].title,
          price: found[0].price ? { price: found[0].price.price, promoPrice: found[0].price.promoPrice } : null,
          promotions: found[0].promotions?.flatMap((p: any) => p.tags?.map((t: any) => t.text) || []) || [],
        };
      } else {
        return {
          sourceProduct: null,
          alternatives: [],
          crossSells: [],
        };
      }
    }

    if (!targetSku) {
      return { alternatives: [] };
    }

    const detailQ = `
    query ProductDetail($sku: String!) {
      product(sku: $sku) {
        title
        sku
        price { price promoPrice }
        alternatives {
          title
          sku
          price { price promoPrice }
        }
        crossSells {
          title
          sku
          price { price promoPrice }
        }
      }
    }
    `;
    const detailRes = await this.executeGraphql<any>(detailQ, { sku: targetSku }, "JUMBO_WEB-loyalty");
    const prod = detailRes?.product;

    if (prod && !sourceProduct) {
      sourceProduct = {
        sku: prod.sku,
        title: prod.title,
        price: prod.price ? { price: prod.price.price, promoPrice: prod.price.promoPrice } : null,
      };
    }

    const alternatives: RecommendedProduct[] = (prod?.alternatives || []).map((a: any) => ({
      sku: a.sku,
      title: a.title,
      price: a.price ? { price: a.price.price, promoPrice: a.price.promoPrice } : null,
    }));

    const crossSells: RecommendedProduct[] = (prod?.crossSells || []).map((c: any) => ({
      sku: c.sku,
      title: c.title,
      price: c.price ? { price: c.price.price, promoPrice: c.price.promoPrice } : null,
    }));

    return {
      sourceProduct: sourceProduct || null,
      alternatives,
      crossSells,
    };
  }

  async searchProducts(options: {
    query: string;
    sort?: "PRICE_ASC" | "PRICE_DESC";
    limit?: number;
  }): Promise<ProductSearchResult> {
    const q = `
    query SearchProductsByKeyword($input: ProductSearchInput!) {
      searchProducts(input: $input) {
        count
        products {
          title
          sku
          link
          price {
            price
            promoPrice
            pricePerUnit {
              price
            }
          }
          availability {
            isAvailable
          }
          promotions {
            tags {
              text
            }
          }
        }
      }
    }
    `;

    const input: Record<string, any> = {
      searchType: "KEYWORD",
      searchTerms: options.query,
    };
    if (options.sort) {
      input.sort = options.sort;
    }

    const res = await this.executeGraphql<any>(q, { input }, "JUMBO_WEB-loyalty");
    const rawProducts = res?.searchProducts?.products || [];
    const limit = options.limit ?? 25;

    const products: ProductSearchItem[] = rawProducts.slice(0, limit).map((p: any) => {
      const priceCents = p.price?.price ?? 0;
      const promoCents = p.price?.promoPrice ?? null;
      const unitCents = p.price?.pricePerUnit?.price ?? null;
      const tags: string[] = p.promotions?.flatMap((pr: any) => pr.tags?.map((t: any) => t.text) || []) || [];

      return {
        sku: p.sku,
        title: p.title,
        url: p.link ? `https://www.jumbo.com${p.link}` : "",
        price: priceCents,
        price_formatted: `€${(priceCents / 100).toFixed(2)}`,
        promo_price: promoCents,
        promo_price_formatted: promoCents !== null ? `€${(promoCents / 100).toFixed(2)}` : null,
        unit_price: unitCents,
        unit_price_formatted: unitCents !== null ? `€${(unitCents / 100).toFixed(2)}` : null,
        is_available: p.availability?.isAvailable ?? true,
        promotions: tags,
      };
    });

    return {
      query: options.query,
      total_count: res?.searchProducts?.count ?? products.length,
      products,
    };
  }

  /**
   * Keyword product search used by the promo digest. Selects the offer-bearing
   * fields `SearchProductDetails` proves exist on `Product` (price, unit price,
   * promotions with validity + volume discounts) — nothing invented.
   */
  private async searchProductForDigest(term: string): Promise<any | null> {
    const q = `
    query PromoDigestSearch($input: ProductSearchInput!) {
      searchProducts(input: $input) {
        count
        products {
          sku
          title
          link
          category: rootCategory
          price {
            price
            promoPrice
            pricePerUnit {
              price
              unit
            }
          }
          availability {
            isAvailable
          }
          promotions {
            id
            group
            tags {
              text
            }
            start {
              date
            }
            end {
              date
            }
            durationTexts {
              shortTitle
            }
            volumeDiscounts {
              discount
              volume
            }
            maxPromotionQuantity
          }
        }
      }
    }
    `;
    const res = await this.executeGraphql<any>(
      q,
      { input: { searchType: "KEYWORD", searchTerms: term } },
      "JUMBO_WEB-loyalty"
    );
    const products = res?.searchProducts?.products;
    return Array.isArray(products) && products.length > 0 ? products[0] : null;
  }

  /** Personalised, account-level offers (not tied to one product). */
  private async getAccountOffers(): Promise<DigestAccountOffer[]> {
    const q = `
    query PromoDigestCustomerPromotions {
      getCustomerPromotions {
        id
        active
        canBeRedeemed
        description
        expirationDate
        eurosDiscount
        percentageDiscount
        minimumSpent
        startDate
        title
      }
    }
    `;
    const res = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    const list = res?.getCustomerPromotions;
    if (!Array.isArray(list)) return [];
    return list
      .filter((p: any) => p && p.active !== false)
      .slice(0, 25)
      .map((p: any) => ({
        id: p.id ?? null,
        title: p.title ?? null,
        description: p.description ?? null,
        euros_discount: p.eurosDiscount ?? null,
        percentage_discount: p.percentageDiscount ?? null,
        minimum_spent: p.minimumSpent ?? null,
        expires_on: p.expirationDate ?? null,
      }));
  }

  /** Shape one mined term into a digest row. Pure mapping — no I/O. */
  private toDigestEntry(term: string, timesBought: number, p: any): PromoDigestEntry {
    const rawPromos = Array.isArray(p?.promotions) ? p.promotions : [];
    const promoTypes: string[] = [];
    const promotions: DigestPromotion[] = rawPromos.map((pr: any) => {
      const tags: string[] = (pr?.tags || [])
        .map((t: any) => t?.text)
        .filter((t: any): t is string => typeof t === "string" && t.length > 0);
      for (const t of tags) if (!promoTypes.includes(t)) promoTypes.push(t);
      return {
        id: pr?.id ?? null,
        group: pr?.group ?? null,
        tags,
        short_title: pr?.durationTexts?.shortTitle ?? null,
        starts_on: pr?.start?.date ?? null,
        ends_on: pr?.end?.date ?? null,
        volume_discounts: (pr?.volumeDiscounts || []).map((v: any) => ({
          discount: v?.discount ?? null,
          volume: v?.volume ?? null,
        })),
        max_promotion_quantity: pr?.maxPromotionQuantity ?? null,
      };
    });

    const was = p?.price?.price ?? null;
    const now = p?.price?.promoPrice ?? null;
    const discount = was !== null && now !== null && now < was ? was - now : null;
    const pct = discount !== null && was ? Math.round((discount / was) * 100) : null;
    const starts = promotions.map((x) => x.starts_on).filter((d): d is string => !!d).sort();
    const ends = promotions.map((x) => x.ends_on).filter((d): d is string => !!d).sort();

    return {
      term,
      times_bought: timesBought,
      product: p
        ? {
            sku: p.sku ?? "",
            title: p.title ?? "",
            url: p.link ? `https://www.jumbo.com${p.link}` : "",
            category: p.category ?? null,
          }
        : null,
      was_price: was,
      now_price: now,
      discount,
      discount_percent: pct,
      unit_price: p?.price?.pricePerUnit?.price ?? null,
      unit: p?.price?.pricePerUnit?.unit ?? null,
      promo_types: promoTypes,
      promotions,
      is_available: p?.availability?.isAvailable ?? false,
      valid_from: starts.length > 0 ? starts[0] : null,
      valid_until: ends.length > 0 ? ends[ends.length - 1] : null,
    };
  }

  /**
   * Small jittered pause between digest API calls (120-200ms). The digest issues
   * back-to-back requests — up to one per scanned receipt plus one search per
   * frequent term — so this keeps the mine from hammering Jumbo's API in a burst.
   * Timing only; results stay deterministic.
   */
  private async digestPause(): Promise<void> {
    const ms = 120 + Math.floor(Math.random() * 80);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * "Of the things I actually buy, what is on offer right now?"
   *
   * Read-only and deterministic: mines recent receipts for purchase frequency,
   * resolves each frequent basket term to a current assortment product via
   * `searchProducts`, and reports the offer price/validity the product carries.
   * Side-effect free — it never writes, never builds a basket, never checks out.
   */
  async getPromoDigest(
    options: {
      days?: number;
      minTimes?: number;
      limit?: number;
      category?: string;
      /** Hard cap on receipt-detail fetches (one request per receipt). */
      maxReceipts?: number;
    } = {}
  ): Promise<PromoDigest> {
    const days = options.days ?? 90;
    const minTimes = options.minTimes ?? 2;
    const limit = options.limit ?? 25;
    const category = options.category?.trim() ? options.category.trim().toLowerCase() : null;
    const maxReceipts = Math.max(1, options.maxReceipts ?? 40);
    const notes: string[] = [];

    // ---- 1. mine recent receipts for what the customer actually buys
    const cutoff = Date.now() - days * 86_400_000;
    const PAGE = 25;
    const receipts: ReceiptOverviewItem[] = [];
    let available = 0;
    for (let page = 0; page < 10 && receipts.length < maxReceipts; page++) {
      let overview: { total_results: number; receipts: ReceiptOverviewItem[] };
      try {
        overview = await this.listReceipts(page, PAGE);
      } catch (e: any) {
        notes.push(`receipt lookup stopped at page ${page}: ${e.message}`);
        break;
      }
      available = overview.total_results ?? available;
      if (!overview.receipts.length) break;
      let stop = false;
      for (const r of overview.receipts) {
        const t = Date.parse(r.datetime);
        if (!Number.isNaN(t) && t < cutoff) {
          stop = true;
          break;
        }
        receipts.push(r);
        if (receipts.length >= maxReceipts) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }

    // ---- 2. count distinct basket terms across those receipts
    const counts = new Map<string, { display: string; n: number }>();
    for (const r of receipts) {
      let d: ReceiptDetails;
      try {
        await this.digestPause();
        d = await this.getReceiptDetails(r.transaction_id);
      } catch {
        continue;
      }
      for (const item of d.items) {
        const key = normalizeTerm(item.name);
        if (!key) continue;
        const existing = counts.get(key);
        if (existing) existing.n++;
        else counts.set(key, { display: item.name.trim(), n: 1 });
      }
    }

    const frequent = [...counts.values()]
      .filter((e) => e.n >= minTimes)
      .sort((a, b) => b.n - a.n || a.display.localeCompare(b.display));

    // ---- 3. resolve each frequent term and keep the ones currently on offer
    const matched: PromoDigestEntry[] = [];
    const notMatched: string[] = [];
    for (const f of frequent) {
      let product: any = null;
      try {
        await this.digestPause();
        product = await this.searchProductForDigest(f.display);
      } catch {
        product = null;
      }
      const entry = this.toDigestEntry(f.display, f.n, product);
      if (category) {
        const cat = (entry.product?.category || "").toLowerCase();
        if (!cat.includes(category)) continue; // out of the requested category
      }
      if (entry.product && entry.promo_types.length > 0) matched.push(entry);
      else notMatched.push(f.display);
    }

    matched.sort(
      (a, b) =>
        b.times_bought - a.times_bought ||
        (b.discount ?? 0) - (a.discount ?? 0) ||
        a.term.localeCompare(b.term)
    );
    const limited = matched.slice(0, limit);

    // ---- 4. supplementary account-level offers
    let accountOffers: DigestAccountOffer[] = [];
    try {
      accountOffers = await this.getAccountOffers();
    } catch (e: any) {
      notes.push(`customer promotions unavailable: ${e.message}`);
    }

    notes.push(
      `Resolution is one keyword search per frequent term; the top hit is used. ${frequent.length} frequent term(s) scanned.`
    );
    notes.push(
      `Receipt mining is capped at the ${maxReceipts} most recent receipt(s) inside ${days} day(s).`
    );

    return {
      days,
      min_times: minTimes,
      limit,
      category,
      matched: limited,
      not_matched: notMatched,
      matched_count: limited.length,
      not_matched_count: notMatched.length,
      account_offers: accountOffers,
      scanned: {
        receipts_scanned: receipts.length,
        receipts_available: available,
        distinct_terms: counts.size,
        frequent_terms: frequent.length,
      },
      notes,
    };
  }

  /** Generic union unwrap: raise on the `*Error` member, enforce the success member. */
  private unwrapUnion<T = any>(
    value: any,
    successTypes: string[],
    operation: string
  ): T {
    const tn = value?.__typename;
    if (typeof tn === "string" && tn.endsWith("Error")) {
      throw new JumboApiError(
        tn,
        value.reason ?? "UNKNOWN",
        value.errorMessage ?? value.message ?? `Jumbo rejected ${operation}.`
      );
    }
    if (typeof tn !== "string" || !successTypes.includes(tn)) {
      throw new JumboApiError(
        tn ?? "Unknown",
        "UNEXPECTED_RESULT",
        `Unexpected result type '${tn ?? "null"}' from ${operation}.`
      );
    }
    return value as T;
  }

  /** Remove shopping-list items by id. `ShoppingListItemIdsResult | ShoppingListError`. */
  async removeShoppingListItems(itemIds: string[]): Promise<string[]> {
    const ids = (itemIds || []).map((s) => String(s).trim()).filter(Boolean);
    if (ids.length === 0) {
      throw new Error("removeShoppingListItems requires at least one item id.");
    }
    const q = `
    mutation RemoveShoppingListItems($input: RemoveShoppingListItemsInput!) {
      removeShoppingListItems(input: $input) {
        __typename
        ... on ShoppingListItemIdsResult {
          itemIds
        }
        ... on ShoppingListError {
          reason
          errorMessage
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(
      q,
      { input: { shoppingListItemIds: ids } },
      "JUMBO_WEB-loyalty"
    );
    const result = data?.removeShoppingListItems;
    this.raiseIfShoppingListError(result, "removing shopping-list items");
    if (result?.__typename !== "ShoppingListItemIdsResult") {
      throw new JumboShoppingListError(
        "UNEXPECTED_RESULT",
        `Unexpected result type '${result?.__typename ?? "null"}' from removeShoppingListItems.`
      );
    }
    return result.itemIds ?? [];
  }

  /**
   * Tick an item off (or back on). Looks the item up first so the edit payload
   * carries the server's own `term`/`sku` alongside `completed`.
   */
  async setShoppingListItemCompleted(
    itemId: string,
    completed: boolean
  ): Promise<ShoppingListItem[]> {
    const list = await this.getShoppingList();
    const item = list.items.find((i) => i.id === itemId);
    if (!item) {
      throw new JumboShoppingListError(
        "ITEM_NOT_FOUND",
        `No shopping-list item with id '${itemId}'.`
      );
    }
    const input: ShoppingListItemInput = {
      term: item.term,
      completed,
      ...(item.id ? { id: item.id } : {}),
      ...(item.sku ? { sku: item.sku } : {}),
    };
    return this.editShoppingListItems({ items: [input] });
  }

  /** Read-only active basket via the GraphQL `ActiveBasket` operation. */
  async getBasket(): Promise<Basket> {
    const q = `
    query ActiveBasket($orderChannel: OrderChannel!) {
      activeBasket {
        __typename
        ... on ActiveBasketResult {
          basket {
            id
            totalProductCount
            lines {
              sku
              id
              quantity
              details {
                title
                price {
                  price
                  promoPrice
                }
                promotions {
                  tags {
                    text
                  }
                }
              }
            }
            calculation {
              totals {
                itemSubtotal {
                  amount
                  currency
                }
                totalToPay {
                  amount
                  currency
                }
              }
            }
          }
        }
        ... on BasketError {
          reason
          errorMessage
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(
      q,
      { orderChannel: "MOBILE_WEB" },
      "JUMBO_WEB-basket"
    );
    const res = this.unwrapUnion<any>(
      data?.activeBasket,
      ["ActiveBasketResult"],
      "reading the active basket"
    );
    const b = res.basket;
    const lines = (b?.lines ?? []).map((l: any) => {
      const d = l.details ?? {};
      const unit = d.price?.price ?? null;
      const promo = d.price?.promoPrice ?? null;
      const qty = l.quantity ?? 0;
      const effective = promo ?? unit;
      return {
        sku: l.sku ?? null,
        id: l.id ?? null,
        title: d.title ?? "",
        quantity: qty,
        unit_price: unit,
        promo_price: promo,
        line_total: effective !== null ? effective * qty : null,
        promotions: (d.promotions ?? []).flatMap(
          (p: any) => (p.tags ?? []).map((t: any) => t.text).filter(Boolean)
        ),
      };
    });
    const totals = b?.calculation?.totals;
    return {
      id: b?.id ?? null,
      total_product_count:
        b?.totalProductCount ?? lines.reduce((a: number, l: any) => a + l.quantity, 0),
      lines,
      subtotal: totals?.itemSubtotal?.amount ?? null,
      total_to_pay: totals?.totalToPay?.amount ?? null,
      currency: totals?.itemSubtotal?.currency ?? null,
    };
  }

  /**
   * Deposits (statiegeld) for a single order. `GetDeposits` requires an orderId:
   * `deposits` is the global catalogue, `returnedDeposits(orderId:)` is per-order.
   */
  async getDeposits(orderId: string): Promise<DepositsResult> {
    const id = String(orderId ?? "").trim();
    if (!id) throw new Error("getDeposits requires an orderId.");
    const q = `
    query GetDeposits($orderId: String!) {
      deposits {
        sku
        description
        category
        chargeType
        unitPrice {
          amount
          currency
        }
      }
      returnedDeposits(orderId: $orderId) {
        __typename
        ... on ReturnedDepositsResponseSuccess {
          returnedDeposits {
            sku
            price {
              amount
              currency
            }
            returnedByCustomerQuantity
          }
          returnedDepositsTotalAmount {
            amount
            currency
          }
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, { orderId: id }, "JUMBO_WEB-orders");

    // The error member's fields are not in the teardown, so only __typename is
    // selected above; surface it verbatim rather than guessing at a message.
    const returned = data?.returnedDeposits;
    if (returned?.__typename && returned.__typename !== "ReturnedDepositsResponseSuccess") {
      throw new JumboApiError(
        returned.__typename,
        returned.reason ?? "UNKNOWN",
        returned.errorMessage ?? `returnedDeposits returned '${returned.__typename}'.`
      );
    }

    return {
      order_id: id,
      deposits: (data?.deposits ?? []).map((d: any) => ({
        sku: d.sku,
        description: d.description ?? "",
        category: d.category ?? null,
        charge_type: d.chargeType ?? null,
        unit_price: d.unitPrice?.amount ?? null,
        currency: d.unitPrice?.currency ?? null,
      })),
      returned: {
        items: (returned?.returnedDeposits ?? []).map((r: any) => ({
          sku: r.sku,
          unit_price: r.price?.amount ?? null,
          currency: r.price?.currency ?? null,
          returned_quantity: r.returnedByCustomerQuantity ?? null,
        })),
        total: returned?.returnedDepositsTotalAmount?.amount ?? null,
        currency: returned?.returnedDepositsTotalAmount?.currency ?? null,
      },
    };
  }

  /** Digital stamps: per-campaign stamp counts, active saving campaigns, buying-stamp balance. */
  async getStamps(): Promise<StampsResult> {
    const q = `
    query GetStamps {
      getDigitalStamps {
        digitalStamps {
          campaignId
          numberStamps
        }
      }
      getCampaigns(active: true, campaignType: "SAVING") {
        active
        id
        title
        campaignCode
        campaignData {
          numberOfStampsPerCard
          stampsNeededForRedemption {
            stamps
            subTitle
          }
          stampType
        }
      }
      getBuyingStampsBalance {
        monetaryValue
        amountOfStamps
        amountOfStampsPerCard
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    return {
      digital_stamps: (data?.getDigitalStamps?.digitalStamps ?? []).map((s: any) => ({
        campaign_id: s.campaignId,
        number_stamps: s.numberStamps ?? 0,
      })),
      saving_campaigns: (data?.getCampaigns ?? []).map((c: any) => ({
        id: c.id,
        title: c.title ?? "",
        campaign_code: c.campaignCode ?? null,
        active: Boolean(c.active),
        stamps_needed_for_redemption:
          c.campaignData?.stampsNeededForRedemption?.stamps ?? null,
        number_of_stamps_per_card: c.campaignData?.numberOfStampsPerCard ?? null,
        stamp_type: c.campaignData?.stampType ?? null,
        starts_at: null,
        ends_at: null,
      })),
      buying_stamps: data?.getBuyingStampsBalance
        ? {
            monetary_value: data.getBuyingStampsBalance.monetaryValue ?? null,
            amount_of_stamps: data.getBuyingStampsBalance.amountOfStamps ?? null,
            amount_of_stamps_per_card:
              data.getBuyingStampsBalance.amountOfStampsPerCard ?? null,
          }
        : null,
    };
  }
}

/** Receipt terms are compared lowercase, trimmed, ignoring the printed promo marker. */
function normalizeTerm(name: string): string {
  return (name || "")
    .replace(/\s+p\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const DUTCH_CITIES: Record<string, { lat: number; lon: number }> = {
  amsterdam: { lat: 52.3676, lon: 4.9041 },
  rotterdam: { lat: 51.9244, lon: 4.4777 },
  "den haag": { lat: 52.0705, lon: 4.3007 },
  "'s-gravenhage": { lat: 52.0705, lon: 4.3007 },
  utrecht: { lat: 52.0907, lon: 5.1214 },
  eindhoven: { lat: 51.4416, lon: 5.4697 },
  groningen: { lat: 53.2194, lon: 6.5665 },
  tilburg: { lat: 51.5719, lon: 5.0672 },
  almere: { lat: 52.3702, lon: 5.2144 },
  breda: { lat: 51.5719, lon: 4.7683 },
  nijmegen: { lat: 51.8126, lon: 5.8372 },
  enschede: { lat: 52.2215, lon: 6.8937 },
  haarlem: { lat: 52.3874, lon: 4.6462 },
  arnhem: { lat: 51.9851, lon: 5.8987 },
  amersfoort: { lat: 52.1561, lon: 5.3878 },
  apeldoorn: { lat: 52.2112, lon: 5.9699 },
  "den bosch": { lat: 51.6978, lon: 5.3037 },
  "'s-hertogenbosch": { lat: 51.6978, lon: 5.3037 },
  maastricht: { lat: 50.8514, lon: 5.691 },
  leiden: { lat: 52.1601, lon: 4.497 },
  dordrecht: { lat: 51.8133, lon: 4.6901 },
  zoetermeer: { lat: 52.0607, lon: 4.494 },
  zwolle: { lat: 52.5168, lon: 6.083 },
  deventer: { lat: 52.255, lon: 6.162 },
  delft: { lat: 52.0116, lon: 4.3571 },
  alkmaar: { lat: 52.6324, lon: 4.7534 },
  venlo: { lat: 51.37, lon: 6.1724 },
  leeuwarden: { lat: 53.2012, lon: 5.7999 },
};

async function resolveCoordinates(
  query?: string,
  latitude?: number,
  longitude?: number
): Promise<{ lat: string; lon: string }> {
  if (latitude !== undefined && longitude !== undefined) {
    return { lat: String(latitude), lon: String(longitude) };
  }
  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    if (DUTCH_CITIES[q]) {
      return {
        lat: DUTCH_CITIES[q].lat.toFixed(4),
        lon: DUTCH_CITIES[q].lon.toFixed(4),
      };
    }
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query + ", Netherlands")}&format=json&limit=1`,
        { headers: { "User-Agent": "jumbo-mcp/0.2.1" } }
      );
      if (res.ok) {
        const data: any = await res.json();
        if (Array.isArray(data) && data.length > 0 && data[0].lat && data[0].lon) {
          return { lat: String(data[0].lat), lon: String(data[0].lon) };
        }
      }
    } catch {
      // Fallback
    }
  }
  return { lat: "52.3676", lon: "4.9041" };
}
