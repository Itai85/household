/**
 * AI Chat — ask open-ended questions about your bills and service.
 *
 * Works with any service category. Builds a context from all bills + tariff history,
 * sends it with the user's question to the configured AI provider.
 */
import type { Service, Bill, TariffEntry, ServiceCategory } from '../types';
import { money, USAGE_UNITS, USAGE_CATEGORIES, formatDate } from '../types';
import { callAi, pickAutoModel, estimateCost, PROVIDERS, type AiConfig, type ProviderId } from './ai-providers';
import { getEffectiveAiConfig, addTokenUsage } from './storage';
import { estimateTokens } from './text-preprocessor';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
  followUps?: string[];  // #9: AI-suggested follow-up questions
}

// ─── #2: Rich category-specific prompts ────────────────────

const CATEGORY_HINTS: Partial<Record<ServiceCategory, string>> = {
  ELECTRICITY: `## Electricity analysis guide
- Analyse the peak / shoulder / off-peak usage split. Calculate the percentage of total kWh in each time band.
- Calculate the supply charge as a percentage of the total bill — for low-usage households it can be 25-35%.
- Compare cost per kWh across periods — if it's rising while usage is flat, rates changed.
- Look for seasonal patterns: winter (heating) vs summer (cooling) vs shoulder seasons.
- Time-of-use optimisation: if most usage is off-peak, a flat-rate plan might be cheaper. If peak usage is high, reducing peak usage (shifting loads) saves the most.
- Check for solar feed-in credits, government rebates, pay-on-time discounts.
- For plan comparison: the supply charge (c/day) is fixed regardless of usage. A plan with a low supply charge benefits low-usage households disproportionately.
- Flag if the plan recently changed or rates increased mid-period (NSW/VIC/QLD price changes happen 1 July each year).`,

  GAS: `## Gas analysis guide
- Analyse seasonal heating patterns — gas usage typically spikes in winter (Jun–Aug in Australia).
- Calculate the supply-to-usage ratio. Gas supply charges can be 30-50% of low-usage bills.
- Track MJ consumption trends across billing periods.
- Look for hot water vs heating split if the bill breaks it down (controlled load vs general).
- Compare cost per MJ across periods.
- Check for pay-on-time discounts and dual-fuel (electricity+gas) bundle savings.
- For plan comparison: consider whether a gas-only or bundled plan is cheaper.`,

  WATER: `## Water analysis guide
- Analyse daily consumption in kL — typical Australian household uses 0.5-0.8 kL/day.
- Look for tiered pricing: first X kL at one rate, excess at a higher rate. Check if the user regularly hits the higher tier.
- Seasonal patterns: summer watering can double usage.
- Leak detection: if winter usage is unusually high (no garden watering), there may be a leak.
- Track sewer charges vs water usage charges — sewer is often a fixed percentage of water usage.
- Compare daily cost across periods, normalised for billing days.`,

  INTERNET: `## Internet analysis guide
- Compare the plan price vs speed tier — is the user paying for speed they don't need?
- Check contract terms: lock-in period, exit fees, auto-renewal.
- Look for bundle discounts (with mobile or streaming).
- Compare against typical market rates: NBN 50 ~$65-75/mo, NBN 100 ~$80-90/mo.
- Check if the plan includes a modem or if they're renting one (hidden $5-10/mo cost).
- Flag if the contract is expiring — the user may be able to negotiate or switch.
- Check data caps vs unlimited.`,

  MOBILE: `## Mobile analysis guide
- Analyse data usage vs plan allowance — are they using most of their data, or overpaying for unused GB?
- Check call/SMS inclusions — most plans now include unlimited calls/SMS.
- Look for international call charges if relevant.
- Compare against market: typical AU plans are $30-50/mo for 20-80GB.
- Check contract vs prepaid — SIM-only plans are usually cheaper.
- Look for device repayment bundled into the plan cost.
- Flag if the contract is ending — opportunity to switch.`,

  HOME_INSURANCE: `## Home insurance analysis guide
- Compare annual premium trends — is it increasing faster than inflation?
- Check sum insured vs estimated replacement cost — underinsurance is common.
- Analyse excess levels: basic excess, voluntary excess. Higher voluntary excess = lower premium, but more out-of-pocket at claim time.
- Look for coverage gaps: flood, storm, accidental damage, contents in open air.
- Check discount eligibility: multi-policy, claims-free, security systems, age-based.
- Compare building vs contents cover separately.
- Flag auto-renewal terms and cooling-off period.`,

  CAR_INSURANCE: `## Car insurance analysis guide
- Compare annual premium trends across years.
- Check coverage type: comprehensive vs third party property vs third party fire & theft.
- Analyse excess structure: basic, voluntary, age excess, inexperienced driver excess. Total excess at claim = sum of all applicable.
- Look for no-claim bonus / rating — how many years, what discount percentage.
- Check agreed value vs market value — agreed value gives certainty but may be outdated.
- Windscreen, hire car, roadside assist — are they included or extras?
- Young/listed driver surcharges can add $500-1500 per claim.
- Compare the total premium including levies and GST.`,

  HEALTH_INSURANCE: `## Health insurance analysis guide
- Compare premium trends — AU health insurance typically rises 3-5% per year.
- Check hospital cover tier: basic, bronze, silver, gold. Does the tier match their needs?
- Analyse extras cover: optical, dental, physio, chiro. Are they using the benefits?
- Calculate extras utilisation: amount claimed vs premium paid for extras. If they claim less than the extras premium portion, they may be better off paying out of pocket.
- Lifetime Health Cover (LHC) loading: 2% per year over age 30 without cover. Check if loading applies.
- Look for waiting periods on new covers.
- Compare individual vs couple vs family rates.
- Check for excess/co-payment amounts on hospital admissions.`,

  LIFE_INSURANCE: `## Life insurance analysis guide
- Compare premium trends — premiums increase with age (stepped) or are locked (level).
- Check cover amount vs needs (income replacement, mortgage, dependents).
- Look for TPD, trauma, and income protection add-ons.
- Flag exclusions and waiting periods.
- Check if held inside or outside super — tax and cost implications differ.`,

  RENT: `## Rent analysis guide
- Track rent changes over time — typical increases are 3-5% per year.
- Calculate weekly vs monthly rate for easy comparison.
- Flag lease expiry dates and notice periods.
- Compare against market rates for the area if the user provides comparables.`,

  MORTGAGE: `## Mortgage analysis guide
- Track interest rate changes over time.
- Calculate principal vs interest split per payment.
- Look for offset account balance impact.
- Compare variable vs fixed rate portions.
- Check for annual/monthly fees that add to effective rate.`,

  STREAMING: `## Streaming/subscription analysis guide
- Calculate total monthly cost across all subscriptions.
- Identify subscriptions that may not be actively used.
- Check for recent price increases.
- Suggest bundle opportunities or cheaper tiers.`,
};

/** Build the system prompt with all service data as context */
function buildSystemPrompt(svc: Service, bills: Bill[]): string {
  const unit = USAGE_UNITS[svc.category] || '';
  const isUsage = USAGE_CATEGORIES.has(svc.category);
  const sortedBills = [...bills].sort((a, b) =>
    (a.periodStart || a.createdAt || '').localeCompare(b.periodStart || b.createdAt || ''));

  // Build bill data table
  let billTable = '';
  if (sortedBills.length > 0) {
    const headers = ['#', 'Period', 'Days', 'Total'];
    if (isUsage) headers.push(`Usage (${unit})`, `${unit}/day`, 'Cost/day');
    billTable = `## Bills\n| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n`;

    for (let i = 0; i < sortedBills.length; i++) {
      const b = sortedBills[i]!;
      const row: string[] = [
        `${i + 1}`,
        `${formatDate(b.periodStart)} – ${formatDate(b.periodEnd)}`,
        `${b.usageDays || '?'}`,
        money(b.totalCents),
      ];
      if (isUsage) {
        const qty = b.usageQuantity || 0;
        const days = b.usageDays || 1;
        row.push(
          qty > 0 ? `${qty.toLocaleString()} ${unit}` : '?',
          qty > 0 && days > 0 ? `${(qty / days).toFixed(1)}` : '?',
          days > 0 ? money(Math.round(b.totalCents / days)) : '?',
        );
      }
      billTable += `| ${row.join(' | ')} |\n`;
    }

    // Summary stats
    const totalCents = sortedBills.reduce((s, b) => s + b.totalCents, 0);
    const totalDays = sortedBills.reduce((s, b) => s + (b.usageDays || 0), 0);
    const totalUsage = sortedBills.reduce((s, b) => s + (b.usageQuantity || 0), 0);
    billTable += `\n**Totals:** ${money(totalCents)} over ${totalDays} days`;
    if (isUsage && totalUsage > 0) {
      billTable += ` | ${totalUsage.toLocaleString()} ${unit} total | ${(totalUsage / Math.max(totalDays, 1)).toFixed(1)} ${unit}/day avg`;
      billTable += ` | Blended rate: ${(totalCents / totalUsage).toFixed(1)} c/${unit}`;
    }
    billTable += '\n';
  }

  // Build tariff table
  let tariffTable = '';
  const currentTariffs = (svc.tariffHistory || []).filter(t => !t.endDate);
  const endedTariffs = (svc.tariffHistory || []).filter(t => t.endDate);
  if (currentTariffs.length > 0) {
    tariffTable = `\n## Current rates & plan details\n`;
    const bySection = new Map<string, TariffEntry[]>();
    for (const t of currentTariffs) {
      const list = bySection.get(t.section) || [];
      list.push(t);
      bySection.set(t.section, list);
    }
    for (const [section, entries] of bySection) {
      tariffTable += `### ${section}\n`;
      for (const e of entries) {
        tariffTable += `- **${e.label}**: ${e.value} (since ${formatDate(e.effectiveDate)})\n`;
      }
    }
  }

  // Rate changes history
  let rateChanges = '';
  if (endedTariffs.length > 0) {
    rateChanges = `\n## Rate change history\n`;
    for (const e of endedTariffs.slice(0, 20)) {
      rateChanges += `- ${e.label}: ${e.value} (${formatDate(e.effectiveDate)} → ${formatDate(e.endDate!)})\n`;
    }
  }

  const categoryHint = CATEGORY_HINTS[svc.category] || '';

  return `You are a household bill analyst assistant for an Australian household. You help people understand their bills, find savings, and make smart decisions about their services.

## Service info
- **Service:** ${svc.nickname}
- **Category:** ${svc.category}
- **Provider:** ${svc.provider || 'Unknown'}
- **Plan:** ${svc.planName || 'Unknown'}
- **Status:** ${svc.status}
${svc.accountNumber ? `- **Account:** ${svc.accountNumber}` : ''}
${svc.contractEndDate ? `- **Contract ends:** ${formatDate(svc.contractEndDate)}` : ''}
${svc.benefitEndDate ? `- **Benefit ends:** ${formatDate(svc.benefitEndDate)}` : ''}

${billTable}
${tariffTable}
${rateChanges}

${categoryHint}

## Response rules
- Answer in the SAME LANGUAGE the user writes in. If they write in Hebrew, answer in Hebrew. If English, answer in English.
- Be specific — use actual numbers from the data above, not generalities.
- When comparing periods, normalise to daily rates (cost/day, ${unit}/day) to account for different billing period lengths.
- Highlight anomalies, trends, and actionable insights.
- If the user asks about switching plans, explain what to look for based on their actual usage profile.
- Keep answers concise but thorough. Use markdown: tables, bullet points, bold for key numbers.
- If you don't have enough data to answer, say so clearly.
- At the END of every response, add a line "---" followed by "**Follow-ups:**" and exactly 2 short follow-up questions the user might want to ask next, as a bullet list. These should be natural next questions based on what you just answered. Keep each under 8 words.`;
}

/** Generate dynamic suggested questions based on the bill data */
export async function generateSuggestions(
  svc: Service,
  bills: Bill[],
  onStatus?: (s: string) => void,
): Promise<string[]> {
  const aiConfig = getEffectiveAiConfig();
  if (!aiConfig) {
    return getStaticSuggestions(svc.category);
  }

  // If no bills AND no tariff data, use static suggestions
  const hasTariffs = (svc.tariffHistory || []).filter(t => !t.endDate).length > 0;
  if (bills.length === 0 && !hasTariffs) {
    return getStaticSuggestions(svc.category);
  }

  const systemPrompt = buildSystemPrompt(svc, bills);
  const isProxy = (aiConfig.providerId as string) === 'server-proxy';
  const resolvedModel = isProxy ? 'fast' : pickAutoModel(aiConfig, false);
  const config: AiConfig = { ...aiConfig, modelId: resolvedModel };

  try {
    onStatus?.('Generating suggestions...');
    const response = await callAi(config, {
      systemPrompt,
      userMessage: `Based on the data above, generate exactly 3 short questions (max 8 words each) that would give the user the most useful insights about their ${svc.category.toLowerCase().replace(/_/g, ' ')} service. Questions should be specific to their data — reference actual numbers, periods, or anomalies you see. Return ONLY a JSON array of 3 strings, nothing else. Example: ["Why did my bill jump 40% in Q2?", "Is my off-peak usage optimal?", "Am I paying too much for supply?"]`,
      maxTokens: 256,
    });

    const inputTokens = response.inputTokens || estimateTokens(systemPrompt);
    const outputTokens = response.outputTokens || estimateTokens(response.content);
    addTokenUsage(inputTokens, outputTokens, estimateCost(config.providerId, resolvedModel, inputTokens, outputTokens));

    let text = response.content.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (match) text = match[0];
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(0, 3).map(String);
    }
  } catch (err) {
    console.warn('[AI Chat] Failed to generate suggestions:', err);
  }

  return getStaticSuggestions(svc.category);
}

/** Static fallback suggestions per category */
function getStaticSuggestions(category: ServiceCategory): string[] {
  switch (category) {
    case 'ELECTRICITY':
      return ['Summarise my electricity costs', 'Tips to reduce my bill'];
    case 'GAS':
      return ['Summarise my gas usage', 'Tips to reduce heating costs'];
    case 'WATER':
      return ['Summarise my water usage', 'Any unusual consumption?'];
    case 'INTERNET':
      return ['Am I on the best plan?', 'When does my contract end?'];
    case 'MOBILE':
      return ['Am I overpaying for data?', 'Summarise my costs'];
    case 'HOME_INSURANCE':
      return ['Summarise my coverage', 'Am I underinsured?'];
    case 'CAR_INSURANCE':
      return ['Summarise my coverage', 'How much is my total excess?'];
    case 'HEALTH_INSURANCE':
      return ['Summarise my coverage', 'Am I using my extras?'];
    case 'LIFE_INSURANCE':
      return ['Summarise my cover', 'Is my cover amount enough?'];
    case 'RENT':
      return ['Track my rent changes', 'When does my lease end?'];
    case 'MORTGAGE':
      return ['Summarise my repayments', 'What rate am I paying?'];
    case 'STREAMING':
    case 'SOFTWARE':
    case 'GYM':
    case 'SUBSCRIPTION_BOX':
      return ['What am I paying monthly?', 'Any recent price increases?'];
    default:
      return ['Summarise my costs', 'Any tips to save?'];
  }
}

// ─── #9: Extract follow-up suggestions from AI response ────

export function extractFollowUps(text: string): { cleanText: string; followUps: string[] } {
  // Look for "---" + "Follow-ups:" pattern at the end
  const dividerMatch = text.match(/\n---\s*\n\*?\*?Follow[- ]?ups?:?\*?\*?\s*\n([\s\S]*?)$/i);
  if (!dividerMatch) return { cleanText: text, followUps: [] };

  const cleanText = text.slice(0, dividerMatch.index).trimEnd();
  const followUpBlock = dividerMatch[1] || '';

  // Extract bullet items
  const items = followUpBlock
    .split('\n')
    .map(line => line.replace(/^[-*•]\s*/, '').replace(/\*\*/g, '').trim())
    .filter(line => line.length > 0 && line.length < 60);

  return { cleanText, followUps: items.slice(0, 3) };
}

/** Ask a question about the service's bills */
export async function askQuestion(
  svc: Service,
  bills: Bill[],
  question: string,
  history: ChatMessage[],
  onStatus?: (s: string) => void,
): Promise<{ answer: string; costUSD: number; followUps: string[] }> {
  const aiConfig = getEffectiveAiConfig();
  if (!aiConfig) throw new Error('No AI provider configured. Go to Settings to add an API key.');

  const systemPrompt = buildSystemPrompt(svc, bills);
  const isProxy = (aiConfig.providerId as string) === 'server-proxy';
  const resolvedModel = isProxy ? 'fast' : pickAutoModel(aiConfig, false);
  const config: AiConfig = { ...aiConfig, modelId: resolvedModel };

  // Build conversation context (last 6 messages for context)
  const recentHistory = history.slice(-6);
  let conversationContext = '';
  if (recentHistory.length > 0) {
    conversationContext = '\n\n## Previous conversation\n';
    for (const msg of recentHistory) {
      conversationContext += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.text}\n\n`;
    }
  }

  const userMessage = conversationContext + `User question: ${question}`;

  // #6: Better loading status
  const providerLabel = isProxy ? 'Server AI' : (PROVIDERS[config.providerId]?.label || config.providerId);
  const billCount = bills.length;
  const tariffCount = (svc.tariffHistory || []).filter(t => !t.endDate).length;
  const contextDesc = billCount > 0 && tariffCount > 0
    ? `Analysing ${billCount} bill${billCount > 1 ? 's' : ''} + ${tariffCount} rates`
    : billCount > 0 ? `Analysing ${billCount} bill${billCount > 1 ? 's' : ''}`
    : tariffCount > 0 ? `Analysing ${tariffCount} rates`
    : 'Thinking';
  onStatus?.(`${contextDesc} (${providerLabel})...`);

  const response = await callAi(config, {
    systemPrompt,
    userMessage,
    maxTokens: 2048,
  });

  const inputTokens = response.inputTokens || estimateTokens(systemPrompt + userMessage);
  const outputTokens = response.outputTokens || estimateTokens(response.content);
  const costUSD = estimateCost(config.providerId, resolvedModel, inputTokens, outputTokens);
  addTokenUsage(inputTokens, outputTokens, costUSD);

  // #9: Extract follow-up suggestions
  const { cleanText, followUps } = extractFollowUps(response.content);

  return { answer: cleanText, costUSD, followUps };
}

/** Build context for plan comparison — returns a summary of the user's usage profile */
export function buildUsageProfile(svc: Service, bills: Bill[]): {
  totalDays: number;
  totalUsage: number;
  totalCost: number;
  avgDaily: number;
  avgDailyCost: number;
  unit: string;
  blendedRate: number;
  currentSupplyCharge: string | null;
  planName: string;
  provider: string;
} | null {
  const unit = USAGE_UNITS[svc.category] || '';
  const sortedBills = [...bills].sort((a, b) =>
    (a.periodStart || '').localeCompare(b.periodStart || ''));

  const totalDays = sortedBills.reduce((s, b) => s + (b.usageDays || 0), 0);
  const totalUsage = sortedBills.reduce((s, b) => s + (b.usageQuantity || 0), 0);
  const totalCost = sortedBills.reduce((s, b) => s + b.totalCents, 0);

  if (totalDays === 0 && totalCost === 0) return null;

  // Find current supply charge from tariff history
  const currentTariffs = (svc.tariffHistory || []).filter(t => !t.endDate);
  const supplyEntry = currentTariffs.find(t =>
    /supply|service.*charge|daily.*charge/i.test(t.label) && t.section === 'tariff'
  );

  return {
    totalDays,
    totalUsage,
    totalCost,
    avgDaily: totalDays > 0 ? totalUsage / totalDays : 0,
    avgDailyCost: totalDays > 0 ? totalCost / totalDays : 0,
    unit,
    blendedRate: totalUsage > 0 ? totalCost / totalUsage : 0,
    currentSupplyCharge: supplyEntry?.value || null,
    planName: svc.planName || 'Unknown',
    provider: svc.provider || 'Unknown',
  };
}

/** Ask AI to compare a new plan against current costs */
export async function comparePlan(
  svc: Service,
  bills: Bill[],
  newPlanDetails: string,
  onStatus?: (s: string) => void,
): Promise<{ analysis: string; costUSD: number }> {
  const aiConfig = getEffectiveAiConfig();
  if (!aiConfig) throw new Error('No AI provider configured. Go to Settings to add an API key.');

  const systemPrompt = buildSystemPrompt(svc, bills);
  const isProxy = (aiConfig.providerId as string) === 'server-proxy';
  const resolvedModel = isProxy ? 'fast' : pickAutoModel(aiConfig, false);
  const config: AiConfig = { ...aiConfig, modelId: resolvedModel };

  const providerLabel = isProxy ? 'Server AI' : (PROVIDERS[config.providerId]?.label || config.providerId);
  onStatus?.(`Comparing plans (${providerLabel})...`);

  const userMessage = `The user wants to compare their current plan against a new plan option. Using their ACTUAL usage data from the bills above, calculate the estimated annual cost for BOTH plans.

New plan details:
${newPlanDetails}

## Instructions
1. Calculate the user's annual cost on their CURRENT plan using their actual usage data (not benchmarks).
2. Calculate what they would pay on the NEW plan with the same usage.
3. Show a clear comparison table.
4. Highlight the winner and the annual savings.
5. Note any risks or caveats (e.g. different peak hour definitions, exit fees, contract terms).
6. Answer in the same language as the new plan details (if Hebrew, answer in Hebrew).

Be precise — show your calculations.`;

  const response = await callAi(config, {
    systemPrompt,
    userMessage,
    maxTokens: 2048,
  });

  const inputTokens = response.inputTokens || estimateTokens(systemPrompt + userMessage);
  const outputTokens = response.outputTokens || estimateTokens(response.content);
  const costUSD = estimateCost(config.providerId, resolvedModel, inputTokens, outputTokens);
  addTokenUsage(inputTokens, outputTokens, costUSD);

  return { analysis: response.content, costUSD };
}

// ─── #4: Chat history persistence ──────────────────────────

const CHAT_STORAGE_KEY = 'ai-chat-history';

export function loadChatHistory(serviceId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`${CHAT_STORAGE_KEY}:${serviceId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* ignore */ }
  return [];
}

export function saveChatHistory(serviceId: string, messages: ChatMessage[]): void {
  try {
    // Keep last 50 messages to avoid bloating localStorage
    const trimmed = messages.slice(-50);
    localStorage.setItem(`${CHAT_STORAGE_KEY}:${serviceId}`, JSON.stringify(trimmed));
  } catch { /* ignore */ }
}

export function clearChatHistory(serviceId: string): void {
  try {
    localStorage.removeItem(`${CHAT_STORAGE_KEY}:${serviceId}`);
  } catch { /* ignore */ }
}
