export interface MoneyForwardAccount {
  name: string;
  id: string;
  subAccountIdHash: string;
  accountString: string;
}

export interface MoneyForwardAsset {
  assetId: string;
  assetSubclassId: string;
  name: string;
  value: number;
  entriedPrice: number | null;
  entriedAt: string | null;
}
