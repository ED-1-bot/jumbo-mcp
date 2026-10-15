export interface TokensData {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  saved_at?: string;
  domain?: string;
  client_id?: string;
}

export interface PkceSession {
  domain: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
  state: string;
  nonce: string;
  created_at: string;
}

export interface ReceiptItem {
  name: string;
  price: number;
  is_promotion: boolean;
}

export interface ReceiptOverviewItem {
  transaction_id: string;
  datetime: string;
  store: string;
  store_id: string;
  points_earned: number;
}

export interface ReceiptDetails extends ReceiptOverviewItem {
  total: number | null;
  payment_method: string | null;
  items_count: number;
  items: ReceiptItem[];
  vat_overview: string[];
  raw_lines: string[];
}

export interface LoyaltyProfile {
  name: string;
  customer_id: string;
  loyalty_card_number: string;
  digital_receipt_enabled: boolean;
  digital_stamps_opt_in: boolean;
}

export interface StoreAddress {
  street?: string;
  houseNumber?: string;
  city?: string;
  postalCode?: string;
}

export interface StoreInfo {
  storeId: string;
  name: string;
  distanceKm: number | null;
  address: StoreAddress;
  openingHours?: Record<string, { opensAt?: string; closesAt?: string }>;
  locationType?: string;
}

export interface ProductPrice {
  price: number;
  promoPrice?: number | null;
}

export interface RecommendedProduct {
  sku: string;
  title: string;
  price?: ProductPrice | null;
  promotions?: string[];
}

export interface ProductRecommendationsResult {
  sourceProduct?: RecommendedProduct | null;
  alternatives: RecommendedProduct[];
  crossSells?: RecommendedProduct[];
  promotions?: RecommendedProduct[];
}

export interface ProductSearchItem {
  sku: string;
  title: string;
  url: string;
  price: number;
  price_formatted: string;
  promo_price: number | null;
  promo_price_formatted: string | null;
  unit_price: number | null;
  unit_price_formatted: string | null;
  is_available: boolean;
  promotions: string[];
}

export interface ProductSearchResult {
  query: string;
  total_count: number;
  products: ProductSearchItem[];
}

// ---------------------------------------------------------------------------
// Shopping list
// Mirrors the app's `fragment ShoppingListItem on ShoppingListItem`
// (completed, id, sku, term) and the EditShoppingListItems / toggleShoppingList
// unions from the APK teardown.
// ---------------------------------------------------------------------------

export interface ShoppingListItem {
  /** Server-assigned id; null if the API omitted it. */
  id: string | null;
  /** Free-text description the user typed, e.g. "eieren". */
  term: string;
  /** SKU when the item is linked to a catalogue product, else null. */
  sku: string | null;
  completed: boolean;
}

export interface ShoppingList {
  isActive: boolean;
  items: ShoppingListItem[];
}

/**
 * Input item for `EditShoppingListItems`. On add only `term` (+ optional
 * `completed`) is sent; on edit the server round-tripped `id`/`sku` are echoed
 * back. `completed` defaults to false server-side.
 */
export interface ShoppingListItemInput {
  id?: string;
  term: string;
  sku?: string | null;
  completed?: boolean;
}

export interface EditShoppingListItemsInput {
  items: ShoppingListItemInput[];
}

// ---------------------------------------------------------------------------
// Basket (read-only), deposits, digital stamps
// ---------------------------------------------------------------------------

export interface BasketLine {
  sku: string | null;
  id: string | null;
  title: string;
  quantity: number;
  /** Unit price in cents (Jumbo's `price.price`). */
  unit_price: number | null;
  /** Promotional unit price in cents, when on offer. */
  promo_price: number | null;
  /** Quantity x applicable unit price, in cents. */
  line_total: number | null;
  promotions: string[];
}

export interface Basket {
  id: string | null;
  total_product_count: number;
  lines: BasketLine[];
  /** `itemSubtotal` in cents. */
  subtotal: number | null;
  /** `totalToPay` in cents. */
  total_to_pay: number | null;
  currency: string | null;
}

export interface DepositProduct {
  sku: string;
  description: string;
  category: string | null;
  charge_type: string | null;
  unit_price: number | null;
  currency: string | null;
}

export interface ReturnedDeposit {
  sku: string;
  unit_price: number | null;
  currency: string | null;
  returned_quantity: number | null;
}

export interface DepositsResult {
  order_id: string;
  /** Global statiegeld catalogue (root `deposits`, order-independent). */
  deposits: DepositProduct[];
  /** Per-order returned deposits (`returnedDeposits(orderId:)`). */
  returned: {
    items: ReturnedDeposit[];
    total: number | null;
    currency: string | null;
  };
}

export interface DigitalStampBalance {
  campaign_id: string;
  number_stamps: number;
}

export interface StampCampaign {
  id: string;
  title: string;
  campaign_code: string | null;
  active: boolean;
  stamps_needed_for_redemption: number | null;
  number_of_stamps_per_card: number | null;
  stamp_type: string | null;
  starts_at: string | null;
  ends_at: string | null;
}

export interface BuyingStampsBalance {
  monetary_value: number | null;
  amount_of_stamps: number | null;
  amount_of_stamps_per_card: number | null;
}

export interface StampsResult {
  digital_stamps: DigitalStampBalance[];
  saving_campaigns: StampCampaign[];
  buying_stamps: BuyingStampsBalance | null;
}

/** ------------------------------------------------------------------ promo digest */

/** A promotion attached to a product in the current assortment. */
export interface DigestPromotion {
  id: string | null;
  group: string | null;
  /** Human-readable offer labels, e.g. "2e halve prijs". */
  tags: string[];
  short_title: string | null;
  /** `date` fields as returned by the API (dd-mm or ISO-ish); no client parsing. */
  starts_on: string | null;
  ends_on: string | null;
  volume_discounts: { discount: number | null; volume: number | null }[];
  max_promotion_quantity: number | null;
}

/** One frequent purchase that is currently on offer (or not). */
export interface PromoDigestEntry {
  /** Normalised receipt term this row was mined from. */
  term: string;
  /** How many times the term appeared across the scanned receipts. */
  times_bought: number;
  /** Resolved assortment product, when search found one. */
  product: { sku: string; title: string; url: string; category: string | null } | null;
  /** Regular shelf price in cents. */
  was_price: number | null;
  /** Current offer price in cents, when a promotion applies. */
  now_price: number | null;
  /** Cents saved vs. the shelf price. */
  discount: number | null;
  discount_percent: number | null;
  /** Unit (per kg/l/piece) price in cents for the offer, when returned. */
  unit_price: number | null;
  unit: string | null;
  /** Offer labels; empty means no current offer. */
  promo_types: string[];
  promotions: DigestPromotion[];
  is_available: boolean;
  /** Earliest start / latest end across attached promotions (API strings). */
  valid_from: string | null;
  valid_until: string | null;
}

/** Account-level (personalised) offer, not tied to a single product. */
export interface DigestAccountOffer {
  id: string | null;
  title: string | null;
  description: string | null;
  euros_discount: number | null;
  percentage_discount: number | null;
  minimum_spent: number | null;
  expires_on: string | null;
}

export interface PromoDigest {
  days: number;
  min_times: number;
  limit: number;
  category: string | null;
  /** Frequent terms that currently carry at least one promotion. */
  matched: PromoDigestEntry[];
  /** Frequent terms with no current offer (or that could not be resolved). */
  not_matched: string[];
  matched_count: number;
  not_matched_count: number;
  /** Personalised account offers, supplementary context only. */
  account_offers: DigestAccountOffer[];
  scanned: {
    receipts_scanned: number;
    receipts_available: number;
    distinct_terms: number;
    frequent_terms: number;
  };
  notes: string[];
}
