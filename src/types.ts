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
