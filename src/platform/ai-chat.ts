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
}

/** Category-specific hints for the AI */
const CATEGORY_HINTS: Partial<Record<ServiceCategory, string>> = {
  ELECTRICITY: `For electricity: analyse peak/shoulder/off-peak usage split, supply charges vs usage charges ratio, seasonal patterns, time-of-use optimisation tips. Supply charge is fixed daily — it matters more for low-usage households.`,
  GAS: `For gas: analyse seasonal heating patterns, supply vs usage ratio, MJ consumption trends, hot water vs heating split if visible.`,
  WATER: `For water: analyse seasonal patterns, tiered pricing thresholds, daily consumption trends, leak detection (unusual spikes).`,
  INTERNET: `For internet: compare plan speed vs price, check if they're on the best available plan, data usage vs allowance, contract lock-in.`,
  MOBILE: `For mobile: check data/call/SMS usage vs plan inclusions, roaming charges, whether a cheaper plan would suit their usage.`,
  HOME_INSURANCE: `For home insurance: compare premium trends, excess levels, coverage gaps, sum insured vs replacement cost, discount eligibility.`,
  CAR_INSURANCE: `For car insurance: compare premium trends, excess levels, coverage type (comprehensive vs third party), no-claim bonus, age-based surcharges.`,
  HEALTH_INSURANCE: `For health insurance: compare premium trends, extras coverage utilisation, hospital tier, waiting periods, lifetime health cover loading.`,
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

  return `You are a household bill analyst assistant. You help people understand their bills, find savings, and make smart decisions about their services.

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

## Your role
${categoryHint}

- Answer in the SAME LANGUAGE the user writes in. If they write in Hebrew, answer in Hebrew. If English, answer in English.
- Be specific — use actual numbers from the data above, not generalities.
- When comparing periods, normalise to daily rates (cost/day, ${unit}/day) to account for different period lengths.
- Highlight anomalies, trends, and actionable insights.
- If the user asks about switching plans, explain what to look for based on their actual usage profile.
- Keep answers concise but thorough. Use tables and bullet points.
- If you don't have enough data to answer, say so clearly.`;
}

/** Generate dynamic suggested questions based on the bill data */
export async function generateSuggestions(
  svc: Service,
  bills: Bill[],
  onStatus?: (s: string) => void,
): Promise<string[]> {
  const aiConfig = getEffectiveAiConfig();
  if (!aiConfig || bills.length === 0) {
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
      userMessage: `Based on the bill data above, generate exactly 3 short questions (max 8 words each) that would give the user the most useful insights. Questions should be specific to their data — reference actual numbers, periods, or anomalies you see. Return ONLY a JSON array of 3 strings, nothing else. Example: ["Why did my bill jump 40% in Q2?", "Is my off-peak usage optimal?", "Am I paying too much for supply?"]`,
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
      return ['Summarise my gas usage', 'Tips to reduce my bill'];
    case 'WATER':
      return ['Summarise my water usage', 'Any unusual consumption?'];
    case 'INTERNET':
      return ['Am I on the best plan?', 'When does my contract end?'];
    case 'MOBILE':
      return ['Am I overpaying for my plan?', 'Summarise my costs'];
    case 'HOME_INSURANCE':
    case 'CAR_INSURANCE':
    case 'HEALTH_INSURANCE':
      return ['Summarise my coverage', 'Is my premium competitive?'];
    default:
      return ['Summarise my costs', 'Any tips to save?'];
  }
}

/** Ask a question about the service's bills */
export async function askQuestion(
  svc: Service,
  bills: Bill[],
  question: string,
  history: ChatMessage[],
  onStatus?: (s: string) => void,
): Promise<{ answer: string; costUSD: number }> {
  const aiConfig = getEffectiveAiConfig();
  if (!aiConfig) throw new Error('No AI provider configured. Go to Settings to add an API key.');

  const systemPrompt = buildSystemPrompt(svc, bills);
  const isProxy = (aiConfig.providerId as string) === 'server-proxy';
  const resolvedModel = isProxy ? 'smart' : pickAutoModel(aiConfig, true);
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

  const providerLabel = isProxy ? 'Server AI' : (PROVIDERS[config.providerId]?.label || config.providerId);
  onStatus?.(`Thinking (${providerLabel})...`);

  const response = await callAi(config, {
    systemPrompt,
    userMessage,
    maxTokens: 2048,
  });

  const inputTokens = response.inputTokens || estimateTokens(systemPrompt + userMessage);
  const outputTokens = response.outputTokens || estimateTokens(response.content);
  const costUSD = estimateCost(config.providerId, resolvedModel, inputTokens, outputTokens);
  addTokenUsage(inputTokens, outputTokens, costUSD);

  return { answer: response.content, costUSD };
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

  if (totalDays === 0) return null;

  // Find current supply charge from tariff history
  const currentTariffs = (svc.tariffHistory || []).filter(t => !t.endDate);
  const supplyEntry = currentTariffs.find(t =>
    /supply|service.*charge|daily.*charge/i.test(t.label) && t.section === 'tariff'
  );

  return {
    totalDays,
    totalUsage,
    totalCost,
    avgDaily: totalUsage / totalDays,
    avgDailyCost: totalCost / totalDays,
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
  const resolvedModel = isProxy ? 'smart' : pickAutoModel(aiConfig, true);
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
