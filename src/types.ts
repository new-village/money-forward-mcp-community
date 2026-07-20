export interface MoneyForwardAccountEntry {
  accountId: string | null;
  institution: string;
  name: string;
  kind: "asset" | "liability";
  category: string | null;
  balance: number;
  currency: "JPY";
  source: "account_detail" | "portfolio" | "liability" | "account_summary";
  registeredAt: string | null;
  lastFetchedAt: string | null;
  status: string | null;
}

export interface MoneyForwardAccount {
  name: string;
  id: string;
}

export interface MoneyForwardAsset {
  assetId: string;
  assetSubclassId: string;
  name: string;
  value: number;
  entryPrice: number | null;
  entryDate: string | null;
}

export interface MoneyForwardAssetBreakdownItem {
  category: string;
  value: number;
  percentage: number;
}

export interface MoneyForwardAssetBreakdown {
  total: number;
  currency: "JPY";
  items: MoneyForwardAssetBreakdownItem[];
}

export interface MoneyForwardAssetDetail {
  name: string;
  value: number;
  institution: string | null;
  details: Record<string, string>;
}

export interface MoneyForwardAssetDetailGroup {
  category: string;
  total: number;
  items: MoneyForwardAssetDetail[];
}

export interface MoneyForwardLiabilityBreakdown {
  total: number;
  currency: "JPY";
  items: MoneyForwardAssetBreakdownItem[];
}

export interface MoneyForwardLiabilityDetail {
  category: string;
  name: string;
  balance: number;
  institution: string | null;
}

export interface MoneyForwardTransaction {
  date: string;
  description: string;
  amount: number;
  direction: "income" | "expense";
  calculationTarget: boolean;
  institution: string | null;
  majorCategory: string | null;
  minorCategory: string | null;
  memo: string | null;
}

export interface MoneyForwardTransactionList {
  periodStart: string;
  periodEnd: string;
  currency: "JPY";
  transactions: MoneyForwardTransaction[];
}

export interface MoneyForwardHouseholdCategory {
  category: string;
  amount: number;
  percentage: number;
  subcategories: Array<{ category: string; amount: number }>;
}

export interface MoneyForwardHouseholdCategorySummary {
  category: string;
  income: number;
  expense: number;
  balance: number;
}

export interface MoneyForwardHouseholdBookSummary {
  period: string;
  currency: "JPY";
  income: number;
  expense: number;
  balance: number;
  categorySummaries: MoneyForwardHouseholdCategorySummary[];
  incomeCategories: MoneyForwardHouseholdCategory[];
  expenseCategories: MoneyForwardHouseholdCategory[];
}
