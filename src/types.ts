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
