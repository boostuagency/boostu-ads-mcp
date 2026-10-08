/** Normalised totals used by the cross-channel tools. Money in account currency. */
export interface ChannelTotals {
  platform: string;
  accountId: string;
  accountName?: string;
  currency?: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
}
