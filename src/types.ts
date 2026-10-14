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
  env: string;
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
