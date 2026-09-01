// ─── Domain Types ───────────────────────────────────────────

export type ServiceCategory =
  | 'ELECTRICITY' | 'GAS' | 'WATER' | 'INTERNET' | 'MOBILE' | 'LANDLINE'
  | 'HOME_INSURANCE' | 'CAR_INSURANCE' | 'HEALTH_INSURANCE' | 'LIFE_INSURANCE'
  | 'CONTENTS_INSURANCE' | 'PET_INSURANCE' | 'TRAVEL_INSURANCE'
  | 'RENT' | 'MORTGAGE' | 'STRATA' | 'COUNCIL_RATES'
  | 'STREAMING' | 'SOFTWARE' | 'GYM' | 'SUBSCRIPTION_BOX'
  | 'VEHICLE_REGISTRATION' | 'ROADSIDE_ASSIST' | 'TOLL_ACCOUNT' | 'PUBLIC_TRANSPORT'
  | 'BANK_FEES' | 'OTHER';

/** Categories that track consumption/usage per billing period */
export const USAGE_CATEGORIES = new Set<ServiceCategory>(['ELECTRICITY', 'GAS', 'WATER']);

/** Map category to default usage unit */
export const USAGE_UNITS: Partial<Record<ServiceCategory, string>> = {
  ELECTRICITY: 'kWh',
  GAS: 'MJ',
  WATER: 'kL',
};

export const CATEGORY_GROUPS: Record<string, { label: string; icon: string; categories: ServiceCategory[] }> = {
  energy:    { label: 'Energy',        icon: '⚡', categories: ['ELECTRICITY', 'GAS'] },
  water:     { label: 'Water',         icon: '💧', categories: ['WATER'] },
  telecom:   { label: 'Telecom',       icon: '📡', categories: ['INTERNET', 'MOBILE', 'LANDLINE'] },
  insurance: { label: 'Insurance',     icon: '🛡️', categories: ['HOME_INSURANCE', 'CAR_INSURANCE', 'HEALTH_INSURANCE', 'LIFE_INSURANCE', 'CONTENTS_INSURANCE', 'PET_INSURANCE', 'TRAVEL_INSURANCE'] },
  housing:   { label: 'Housing',       icon: '🏠', categories: ['RENT', 'MORTGAGE', 'STRATA', 'COUNCIL_RATES'] },
  transport: { label: 'Transport',     icon: '🚗', categories: ['VEHICLE_REGISTRATION', 'ROADSIDE_ASSIST', 'TOLL_ACCOUNT', 'PUBLIC_TRANSPORT'] },
  subs:      { label: 'Subscriptions', icon: '📦', categories: ['STREAMING', 'SOFTWARE', 'GYM', 'SUBSCRIPTION_BOX'] },
  finance:   { label: 'Finance',       icon: '🏦', categories: ['BANK_FEES'] },
  other:     { label: 'Other',         icon: '📋', categories: ['OTHER'] },
};

export type BillingFrequency =
  | 'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY' | 'QUARTERLY'
  | 'HALF_YEARLY' | 'ANNUALLY' | 'IRREGULAR';

export const FREQUENCY_LABELS: Record<BillingFrequency, string> = {
  WEEKLY: 'Weekly', FORTNIGHTLY: 'Fortnightly', MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly', HALF_YEARLY: 'Half-Yearly',
  ANNUALLY: 'Annually', IRREGULAR: 'Irregular',
};

export const FREQUENCY_MONTHS: Record<BillingFrequency, number> = {
  WEEKLY: 12 / 52 * 7, FORTNIGHTLY: 12 / 26, MONTHLY: 1,
  QUARTERLY: 3, HALF_YEARLY: 6, ANNUALLY: 12, IRREGULAR: 1,
};

export type ServiceStatus = 'ACTIVE' | 'PENDING' | 'CANCELLED' | 'EXPIRED';

export type DocumentType = 'BILL' | 'CONTRACT' | 'PDS' | 'RENEWAL_NOTICE' | 'CORRESPONDENCE' | 'RECEIPT' | 'CERTIFICATE';

export const DOC_TYPE_LABELS: Record<DocumentType, { label: string; icon: string }> = {
  BILL:           { label: 'Bill',              icon: '🧾' },
  PDS:            { label: 'Product Disclosure', icon: '📋' },
  CONTRACT:       { label: 'Contract',          icon: '📝' },
  RENEWAL_NOTICE: { label: 'Renewal Notice',    icon: '🔄' },
  CORRESPONDENCE: { label: 'Letter',            icon: '✉️' },
  RECEIPT:        { label: 'Receipt',           icon: '🧾' },
  CERTIFICATE:    { label: 'Certificate',       icon: '📜' },
};

// ─── Entity interfaces ─────────────────────────────────────

export interface Service {
  id: string;
  nickname: string;
  category: ServiceCategory;
  provider: string;
  planName: string;
  status: ServiceStatus;
  amountCents: number;           // per-period cost in cents (fixed services) or last bill
  billingFrequency: BillingFrequency;
  startDate: string;             // ISO date
  benefitEndDate: string;
  contractEndDate: string;
  exitFeeCents: number;
  accountNumber: string;
  meterIdentifier: string;       // NMI / MIRN
  notes: string;
  summary?: string;              // AI-generated contract/policy summary
  customFields: CustomField[];   // user-added key-value data
  tariffHistory: TariffEntry[];  // rate changes over time
  billAvgMonthlyCents?: number;  // computed: average monthly cost from bill history
  billCount?: number;            // computed: number of bills on record
  createdAt: string;
  updatedAt: string;
}

export interface CustomField {
  label: string;
  value: string;
  section?: 'tariff' | 'contract' | 'clause';
}

/** A single tariff/rate entry with an effective date — allows tracking rate changes over time */
export interface TariffEntry {
  id: string;
  label: string;         // e.g. "Supply charge", "Usage rate", "Exit fee"
  value: string;         // e.g. "25.3c/day", "$150.00"
  section: 'tariff' | 'contract' | 'clause' | 'identifier' | 'amount' | 'coverage';
  effectiveDate: string; // ISO date — when this rate started
  endDate?: string;      // ISO date — when superseded (empty = current)
  source: 'parsed' | 'manual';
  docId?: string;        // which document it came from
}

export interface Bill {
  id: string;
  serviceId: string;
  periodStart: string;
  periodEnd: string;
  totalCents: number;
  usageQuantity: number | null;
  usageUnit: string | null;      // 'kWh', 'MJ', 'kL', etc.
  usageDays: number | null;
  lineItems: BillLineItem[];
  notes: string;
  createdAt: string;
}

export interface BillLineItem {
  id: string;
  description: string;
  amountCents: number;
  quantity: number | null;
  unitRate: number | null;
}

export interface Document {
  id: string;
  serviceId: string;
  title: string;
  docTypes: DocumentType[];
  docDate: string;
  ocrText: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  insights: DocInsight[];        // parsed insights from OCR
  userEdits: DocUserEdits;       // user overrides/additions
  createdAt: string;
}

export interface DocInsight {
  label: string;
  value: string;
  source?: string;               // original OCR line
  section: 'tariff' | 'contract' | 'clause' | 'identifier' | 'amount' | 'date' | 'coverage';
  importance: 'high' | 'medium' | 'low';
}

export interface DocUserEdits {
  overrides: Record<string, string>;  // label → new value
  hidden: string[];                    // labels to hide
  custom: { label: string; value: string }[];  // added manually
  notes: string;
}

export const emptyUserEdits = (): DocUserEdits => ({
  overrides: {}, hidden: [], custom: [], notes: '',
});

// ─── Formatting helpers ─────────────────────────────────────

export function money(cents: number, short = false): string {
  const dollars = cents / 100;
  if (short && Math.abs(dollars) >= 1000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${dollars.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function humanise(snake: string): string {
  return snake.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function monthlyAmount(cents: number, freq: BillingFrequency): number {
  const months = FREQUENCY_MONTHS[freq] || 1;
  return Math.round(cents / months);
}

export function annualAmount(cents: number, freq: BillingFrequency): number {
  return monthlyAmount(cents, freq) * 12;
}

export function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Calculate the average monthly cost from a list of bills.
 * Uses the total time span from earliest to latest bill to get an accurate monthly average,
 * rather than just averaging bill amounts (which doesn't account for varying period lengths).
 */
export function calcBillAvgMonthly(bills: Bill[]): number {
  const withAmount = bills.filter(b => b.totalCents > 0);
  if (withAmount.length === 0) return 0;

  // If bills have period dates, use the full time span for an accurate average
  const withDates = withAmount.filter(b => b.periodStart && b.periodEnd);
  if (withDates.length >= 2) {
    const sorted = [...withDates].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    const earliest = new Date(sorted[0]!.periodStart);
    const latest = new Date(sorted[sorted.length - 1]!.periodEnd);
    const totalDays = (latest.getTime() - earliest.getTime()) / 86400000;
    if (totalDays > 0) {
      const totalCents = sorted.reduce((s, b) => s + b.totalCents, 0);
      const months = totalDays / 30.44;
      return Math.round(totalCents / months);
    }
  }

  // Fallback: simple average of bill amounts, assume quarterly
  const avg = withAmount.reduce((s, b) => s + b.totalCents, 0) / withAmount.length;
  // Try to detect period length from usageDays
  const avgDays = withAmount.filter(b => b.usageDays).reduce((s, b) => s + b.usageDays!, 0) / (withAmount.filter(b => b.usageDays).length || 1);
  const months = avgDays > 0 ? avgDays / 30.44 : 3; // default quarterly
  return Math.round(avg / months);
}

/**
 * The effective monthly amount for a service.
 * Only metered services (electricity/gas/water) use bill average —
 * everything else has a known fixed price that shouldn't be overridden.
 */
export function effectiveMonthly(svc: Service): number {
  // Only metered services use bill average (they have no fixed price)
  if (USAGE_CATEGORIES.has(svc.category) && svc.billAvgMonthlyCents && svc.billAvgMonthlyCents > 0) {
    return svc.billAvgMonthlyCents;
  }
  return monthlyAmount(svc.amountCents, svc.billingFrequency);
}
