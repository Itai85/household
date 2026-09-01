/**
 * Bill forecast engine.
 *
 * For metered services (electricity/gas/water):
 *   Takes historical usage data + current tariff rates → estimates next bill.
 *   Uses average daily usage from recent bills × expected days × current rates.
 *
 * For fixed services (rent/mortgage/insurance/subscriptions):
 *   Next bill = current known amount.
 *
 * For variable-but-unmetered (council rates, strata, tolls):
 *   Repeat last bill amount, adjusted for any known rate change.
 */
import type { Bill, Service, TariffEntry } from '../types';
import { USAGE_CATEGORIES, USAGE_UNITS, FREQUENCY_MONTHS } from '../types';

export interface ForecastResult {
  /** Estimated total in cents */
  estimatedCents: number;
  /** Estimated usage quantity (kWh/MJ/kL) — null for non-metered */
  estimatedUsage: number | null;
  /** Unit for usage */
  usageUnit: string | null;
  /** Estimated period days */
  estimatedDays: number;
  /** When the next bill period is expected to start */
  periodStart: string;
  /** When the next bill period is expected to end */
  periodEnd: string;
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
  /** How the forecast was calculated */
  method: string;
  /** Breakdown of charges */
  breakdown: ForecastLine[];
  /** Comparison to last bill */
  vsLastBill: { lastCents: number; diffCents: number; diffPct: number } | null;
}

export interface ForecastLine {
  label: string;
  detail: string;
  amountCents: number;
}

/** Parse a tariff value string to extract the numeric rate and unit */
function parseRate(value: string): { rate: number; unit: string } | null {
  // "26.43 cents/kWh" or "26.43c/kWh"
  const centsMatch = value.match(/([\d,.]+)\s*(?:cents?|c)\s*\/?\s*(kWh|MJ|kL|day|d)/i);
  if (centsMatch) {
    return { rate: parseFloat(centsMatch[1]!.replace(/,/g, '')), unit: centsMatch[2]!.toLowerCase() };
  }
  // "$1.23/day" or "$1.23 per day"
  const dollarMatch = value.match(/\$\s*([\d,.]+)\s*(?:\/|\s*per\s*)\s*(day|month|kWh|MJ|kL)/i);
  if (dollarMatch) {
    const unit = dollarMatch[2]!.toLowerCase();
    const dollars = parseFloat(dollarMatch[1]!.replace(/,/g, ''));
    // Convert to cents if per-unit (not per day/month)
    if (['kwh', 'mj', 'kl'].includes(unit)) {
      return { rate: dollars * 100, unit };
    }
    return { rate: dollars * 100, unit };
  }
  // Plain number with unit hint from label
  const plainMatch = value.match(/([\d,.]+)/);
  if (plainMatch) {
    return { rate: parseFloat(plainMatch[1]!.replace(/,/g, '')), unit: 'unknown' };
  }
  return null;
}

/** Get current (non-ended) tariff entries for a service */
function getCurrentTariffs(svc: Service): TariffEntry[] {
  return (svc.tariffHistory || []).filter(t => !t.endDate && t.section === 'tariff');
}

/** Calculate average daily usage from bills */
function avgDailyUsage(bills: Bill[]): { avg: number; days: number; bills: number } | null {
  const usageBills = bills.filter(b => b.usageQuantity && b.usageQuantity > 0 && b.usageDays && b.usageDays > 0);
  if (usageBills.length === 0) return null;

  // Use the most recent 4 bills for the average (seasonal smoothing)
  const recent = usageBills
    .sort((a, b) => (b.periodStart || '').localeCompare(a.periodStart || ''))
    .slice(0, 4);

  const totalQty = recent.reduce((s, b) => s + (b.usageQuantity || 0), 0);
  const totalDays = recent.reduce((s, b) => s + (b.usageDays || 0), 0);

  return { avg: totalQty / totalDays, days: totalDays, bills: recent.length };
}

/** Estimate expected billing period days from history */
function estimatePeriodDays(bills: Bill[], svc: Service): number {
  // From bill history
  const withDays = bills.filter(b => b.usageDays && b.usageDays > 0);
  if (withDays.length > 0) {
    const avgDays = withDays.reduce((s, b) => s + b.usageDays!, 0) / withDays.length;
    return Math.round(avgDays);
  }
  // From billing frequency
  const freqMonths = FREQUENCY_MONTHS[svc.billingFrequency] || 3;
  return Math.round(freqMonths * 30.44);
}

/** Estimate next period dates */
function estimateNextPeriod(bills: Bill[], periodDays: number): { start: string; end: string } {
  const sorted = [...bills]
    .filter(b => b.periodEnd)
    .sort((a, b) => (b.periodEnd || '').localeCompare(a.periodEnd || ''));

  if (sorted.length > 0) {
    // Next period starts day after last period ended
    const lastEnd = new Date(sorted[0]!.periodEnd);
    const nextStart = new Date(lastEnd);
    nextStart.setDate(nextStart.getDate() + 1);
    const nextEnd = new Date(nextStart);
    nextEnd.setDate(nextEnd.getDate() + periodDays - 1);
    return {
      start: nextStart.toISOString().slice(0, 10),
      end: nextEnd.toISOString().slice(0, 10),
    };
  }

  // No history — estimate from today
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + periodDays);
  return { start: now.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/**
 * Forecast the next bill for a metered service (electricity/gas/water).
 * Uses average daily usage × current tariff rates.
 */
function forecastMetered(svc: Service, bills: Bill[]): ForecastResult | null {
  const usage = avgDailyUsage(bills);
  if (!usage) return null;

  const tariffs = getCurrentTariffs(svc);
  if (tariffs.length === 0) return null;

  const periodDays = estimatePeriodDays(bills, svc);
  const period = estimateNextPeriod(bills, periodDays);
  const unit = USAGE_UNITS[svc.category] || 'units';
  const totalUsage = usage.avg * periodDays;

  const breakdown: ForecastLine[] = [];
  let totalCents = 0;

  // ── Supply charge ──
  const supplyEntry = tariffs.find(t =>
    /supply/i.test(t.label) || /daily.*supply/i.test(t.label)
  );
  if (supplyEntry) {
    const parsed = parseRate(supplyEntry.value);
    if (parsed && /day|d/.test(parsed.unit)) {
      const supplyCents = parsed.rate * periodDays;
      totalCents += supplyCents;
      breakdown.push({
        label: 'Supply charge',
        detail: `${supplyEntry.value} × ${periodDays} days`,
        amountCents: Math.round(supplyCents),
      });
    }
  }

  // ── Usage rates ──
  // Try to find peak/off-peak/shoulder split
  const peakEntry = tariffs.find(t => /^peak\s*rate/i.test(t.label));
  const offPeakEntry = tariffs.find(t => /off[\s-]*peak/i.test(t.label));
  const shoulderEntry = tariffs.find(t => /shoulder/i.test(t.label));
  const generalEntry = tariffs.find(t =>
    /^usage\s*rate/i.test(t.label) || /^general.*rate/i.test(t.label) || /^anytime/i.test(t.label)
  );

  if (peakEntry || offPeakEntry || shoulderEntry) {
    // TOU (Time of Use) — estimate split from last bill or use defaults
    // Default split: 30% peak, 40% off-peak, 30% shoulder (if all three exist)
    const hasAll = peakEntry && offPeakEntry && shoulderEntry;
    const peakPct = hasAll ? 0.30 : peakEntry && offPeakEntry ? 0.45 : 1.0;
    const offPeakPct = hasAll ? 0.40 : peakEntry && offPeakEntry ? 0.55 : 0;
    const shoulderPct = hasAll ? 0.30 : 0;

    if (peakEntry) {
      const parsed = parseRate(peakEntry.value);
      if (parsed) {
        const qty = totalUsage * peakPct;
        const cost = parsed.rate * qty;
        totalCents += cost;
        breakdown.push({
          label: 'Peak usage',
          detail: `${qty.toFixed(0)} ${unit} × ${parsed.rate.toFixed(2)}c/${unit}`,
          amountCents: Math.round(cost),
        });
      }
    }
    if (offPeakEntry) {
      const parsed = parseRate(offPeakEntry.value);
      if (parsed) {
        const qty = totalUsage * offPeakPct;
        const cost = parsed.rate * qty;
        totalCents += cost;
        breakdown.push({
          label: 'Off-peak usage',
          detail: `${qty.toFixed(0)} ${unit} × ${parsed.rate.toFixed(2)}c/${unit}`,
          amountCents: Math.round(cost),
        });
      }
    }
    if (shoulderEntry) {
      const parsed = parseRate(shoulderEntry.value);
      if (parsed) {
        const qty = totalUsage * shoulderPct;
        const cost = parsed.rate * qty;
        totalCents += cost;
        breakdown.push({
          label: 'Shoulder usage',
          detail: `${qty.toFixed(0)} ${unit} × ${parsed.rate.toFixed(2)}c/${unit}`,
          amountCents: Math.round(cost),
        });
      }
    }
  } else if (generalEntry) {
    // Single rate
    const parsed = parseRate(generalEntry.value);
    if (parsed) {
      const cost = parsed.rate * totalUsage;
      totalCents += cost;
      breakdown.push({
        label: 'Usage',
        detail: `${totalUsage.toFixed(0)} ${unit} × ${parsed.rate.toFixed(2)}c/${unit}`,
        amountCents: Math.round(cost),
      });
    }
  }

  // ── Controlled load ──
  const controlledEntry = tariffs.find(t => /controlled/i.test(t.label));
  if (controlledEntry) {
    const parsed = parseRate(controlledEntry.value);
    if (parsed) {
      // Controlled load is typically a small fraction of total usage
      const clUsage = totalUsage * 0.10;
      const cost = parsed.rate * clUsage;
      totalCents += cost;
      breakdown.push({
        label: 'Controlled load',
        detail: `~${clUsage.toFixed(0)} ${unit} × ${parsed.rate.toFixed(2)}c/${unit}`,
        amountCents: Math.round(cost),
      });
    }
  }

  // ── Solar credit (subtract) ──
  const feedInEntry = tariffs.find(t => /feed[\s-]*in/i.test(t.label));
  // Don't automatically apply solar — we don't know export quantity

  // ── Discount ──
  const discountEntry = tariffs.find(t => /discount/i.test(t.label));
  if (discountEntry) {
    const pctMatch = discountEntry.value.match(/(\d+)\s*%/);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1]!) / 100;
      // Discount typically applies to usage only, not supply
      const usageCosts = breakdown.filter(b => b.label !== 'Supply charge').reduce((s, b) => s + b.amountCents, 0);
      const discountCents = usageCosts * pct;
      totalCents -= discountCents;
      breakdown.push({
        label: `Discount (${pctMatch[1]}%)`,
        detail: `Applied to usage charges`,
        amountCents: -Math.round(discountCents),
      });
    }
  }

  // ── GST ──
  const gstCents = totalCents * 0.10;
  totalCents += gstCents;
  breakdown.push({
    label: 'GST (10%)',
    detail: 'Estimated',
    amountCents: Math.round(gstCents),
  });

  // Comparison to last bill
  const lastBill = [...bills].sort((a, b) => (b.periodStart || '').localeCompare(a.periodStart || ''))[0];
  const vsLastBill = lastBill ? {
    lastCents: lastBill.totalCents,
    diffCents: Math.round(totalCents) - lastBill.totalCents,
    diffPct: lastBill.totalCents > 0 ? ((Math.round(totalCents) - lastBill.totalCents) / lastBill.totalCents) * 100 : 0,
  } : null;

  return {
    estimatedCents: Math.round(totalCents),
    estimatedUsage: Math.round(totalUsage),
    usageUnit: unit,
    estimatedDays: periodDays,
    periodStart: period.start,
    periodEnd: period.end,
    confidence: usage.bills >= 3 ? 'high' : usage.bills >= 2 ? 'medium' : 'low',
    method: `Based on avg ${usage.avg.toFixed(1)} ${unit}/day from ${usage.bills} recent bill${usage.bills > 1 ? 's' : ''}, applied to current tariffs`,
    breakdown,
    vsLastBill,
  };
}

/**
 * Forecast for fixed/known-amount services.
 * Next bill = current service amount.
 */
function forecastFixed(svc: Service, bills: Bill[]): ForecastResult | null {
  if (svc.amountCents <= 0) return null;

  const periodDays = estimatePeriodDays(bills, svc);
  const period = estimateNextPeriod(bills, periodDays);

  const lastBill = [...bills].sort((a, b) => (b.periodStart || '').localeCompare(a.periodStart || ''))[0];
  const vsLastBill = lastBill && lastBill.totalCents !== svc.amountCents ? {
    lastCents: lastBill.totalCents,
    diffCents: svc.amountCents - lastBill.totalCents,
    diffPct: lastBill.totalCents > 0 ? ((svc.amountCents - lastBill.totalCents) / lastBill.totalCents) * 100 : 0,
  } : null;

  return {
    estimatedCents: svc.amountCents,
    estimatedUsage: null,
    usageUnit: null,
    estimatedDays: periodDays,
    periodStart: period.start,
    periodEnd: period.end,
    confidence: 'high',
    method: `Current ${FREQUENCY_MONTHS[svc.billingFrequency] ? svc.billingFrequency.toLowerCase().replace('_', '-') : ''} amount`,
    breakdown: [{
      label: svc.billingFrequency === 'ANNUALLY' ? 'Annual amount' : 'Period amount',
      detail: `Per ${svc.billingFrequency.toLowerCase().replace('_', ' ')}`,
      amountCents: svc.amountCents,
    }],
    vsLastBill,
  };
}

/**
 * Forecast for variable non-metered services (council rates, strata, tolls).
 * Uses last bill amount or service amount.
 */
function forecastFromHistory(svc: Service, bills: Bill[]): ForecastResult | null {
  const lastBill = [...bills].sort((a, b) => (b.periodStart || '').localeCompare(a.periodStart || ''))[0];
  const amount = lastBill?.totalCents || svc.amountCents;
  if (amount <= 0) return null;

  const periodDays = estimatePeriodDays(bills, svc);
  const period = estimateNextPeriod(bills, periodDays);

  return {
    estimatedCents: amount,
    estimatedUsage: null,
    usageUnit: null,
    estimatedDays: periodDays,
    periodStart: period.start,
    periodEnd: period.end,
    confidence: bills.length >= 2 ? 'medium' : 'low',
    method: lastBill ? 'Repeating last bill amount' : 'Using current service amount',
    breakdown: [{
      label: 'Expected amount',
      detail: lastBill ? `Same as last bill (${new Date(lastBill.periodStart).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })})` : 'From service record',
      amountCents: amount,
    }],
    vsLastBill: null,
  };
}

// ─── Categories and their forecast strategies ──────────────

/** Categories where the amount is fixed/known ahead of time */
const FIXED_CATEGORIES = new Set([
  'RENT', 'MORTGAGE', 'STREAMING', 'SOFTWARE', 'GYM', 'SUBSCRIPTION_BOX',
  'INTERNET', 'MOBILE', 'LANDLINE', 'BANK_FEES', 'ROADSIDE_ASSIST',
  'PUBLIC_TRANSPORT',
]);

/** Categories where billing is variable but not metered — use historical */
const HISTORICAL_CATEGORIES = new Set([
  'COUNCIL_RATES', 'STRATA', 'TOLL_ACCOUNT',
  'HOME_INSURANCE', 'CAR_INSURANCE', 'HEALTH_INSURANCE', 'LIFE_INSURANCE',
  'CONTENTS_INSURANCE', 'PET_INSURANCE', 'TRAVEL_INSURANCE',
  'VEHICLE_REGISTRATION',
]);

/**
 * Main forecast function — picks the right strategy based on service category.
 */
export function forecastNextBill(svc: Service, bills: Bill[]): ForecastResult | null {
  // Metered services — usage × tariff
  if (USAGE_CATEGORIES.has(svc.category)) {
    const metered = forecastMetered(svc, bills);
    if (metered) return metered;
    // Fallback to history if no tariffs or usage data
    return forecastFromHistory(svc, bills);
  }

  // Fixed amount services
  if (FIXED_CATEGORIES.has(svc.category)) {
    return forecastFixed(svc, bills);
  }

  // Variable/historical
  if (HISTORICAL_CATEGORIES.has(svc.category)) {
    return forecastFromHistory(svc, bills);
  }

  // Unknown — try fixed, then history
  return forecastFixed(svc, bills) || forecastFromHistory(svc, bills);
}
