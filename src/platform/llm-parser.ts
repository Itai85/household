/**
 * Smart AI document parser — multi-provider.
 *
 * Architecture:
 * 1. Regex detects provider + category (free, instant)
 * 2. Text preprocessor strips boilerplate (saves 30-60% tokens)
 * 3. Focused prompt based on document type
 * 4. Routes to whichever AI provider the user configured (Claude, ChatGPT, Gemini, etc.)
 * 5. Token tracking so users see exactly what they're spending
 */
import type { DocInsight, DocumentType, ServiceCategory } from '../types';
import type { ParseResult } from './document-parser';
import { preprocessText, estimateTokens } from './text-preprocessor';
import { addTokenUsage } from './storage';
import { callAi, pickAutoModel, estimateCost, PROVIDERS, type AiConfig, type ProviderId } from './ai-providers';

/** The structured JSON schema we ask the AI to return */
interface LlmParseResponse {
  provider: string | null;
  category: ServiceCategory | null;
  documentTypes: DocumentType[];
  title: string;
  docDate: string | null;
  summary: string;
  fields: {
    label: string;
    value: string;
    section: 'tariff' | 'contract' | 'clause' | 'identifier' | 'amount' | 'date' | 'coverage';
    importance: 'high' | 'medium' | 'low';
    source?: string;
  }[];
}

export interface LlmParseResult extends ParseResult {
  summary: string;
  tokenUsage: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: ProviderId;
  estimatedCostUSD: number;
}

// ─── Document-type specific prompts ─────────────────────────
// These work across ALL providers — they're just text.

const BILL_PROMPT = `You are parsing an Australian utility/service BILL.
Extract the billing data as structured JSON. Focus on what matters for bill tracking:

Return ONLY valid JSON:
{
  "provider": "company name",
  "category": "ELECTRICITY|GAS|WATER|INTERNET|MOBILE|...",
  "documentTypes": ["BILL"],
  "title": "Provider — Bill Mon YYYY",
  "docDate": "YYYY-MM-DD",
  "summary": "2-sentence summary: what period, how much, any notable charges or changes",
  "fields": [
    {"label": "...", "value": "...", "section": "...", "importance": "high|medium|low"}
  ]
}

MUST extract these if present:
- section "amount": Total amount ($), GST, new charges, previous balance, payment received, solar credit
- section "amount": Usage quantity (kWh/MJ/kL — include the number AND unit), usage days
- section "tariff": ALL rate/tariff entries — supply charge, peak/off-peak/shoulder rates, controlled load, feed-in tariff, discounts. Convert $/kWh to cents/kWh (multiply by 100). Include units (cents/kWh, cents/day, etc.)
- section "date": Issue date, due date, period start, period end, next meter read
- section "identifier": Account number, NMI/MIRN, supply address
- section "contract": Billing frequency, payment method
- section "clause": Any price change notices, plan change warnings

For tariff rates from tables with columns like "Qty | Unit Rate | Amount":
- The Unit Rate column has the tariff rate (often in $/kWh format — convert to cents/kWh)
- The Amount column is the period charge (NOT the tariff rate)

IMPORTANT: Extract EVERY tariff/rate you can find. These are crucial for tracking cost changes over time.`;

const INSURANCE_PROMPT = `You are parsing an Australian INSURANCE document (policy, certificate, PDS, or renewal).
Extract coverage and premium data as structured JSON.

Return ONLY valid JSON:
{
  "provider": "company name",
  "category": "HOME_INSURANCE|CAR_INSURANCE|HEALTH_INSURANCE|...",
  "documentTypes": ["CONTRACT"|"CERTIFICATE"|"PDS"|"RENEWAL_NOTICE"],
  "title": "Provider — Product Name",
  "docDate": "YYYY-MM-DD",
  "summary": "2-4 sentences: what's covered, key limits, notable features or exclusions",
  "fields": [...]
}

MUST extract:
- section "tariff": Premium (total, car, extras), excess (basic, voluntary, age, young driver), sum insured/agreed value, window glass excess
- section "coverage": EVERY coverage item with its status (Included/Not included/Optional/Restricted) or limit. For health: list each clinical category. For car: comprehensive/third-party, hire car, windscreen, roadside, new car replacement, personal effects
- section "contract": Policy period (start/end), cover type, product name, payment frequency, cooling-off period, membership type
- section "identifier": Policy number, vehicle details, registration
- section "clause": Auto-renewal terms, exclusions, conditions, claim process notes

For premium tables with multiple columns (Amount, GST, Levy, Total) — use the TOTAL column.
For health insurance extras: extract benefit per consultation AND annual limit as separate tariff entries.`;

const CONTRACT_PROMPT = `You are parsing an Australian service CONTRACT, agreement, or plan document.
Extract the contract terms as structured JSON.

Return ONLY valid JSON:
{
  "provider": "company name",
  "category": "the service category",
  "documentTypes": ["CONTRACT"],
  "title": "Provider — Plan Name",
  "docDate": "YYYY-MM-DD",
  "summary": "2-3 sentences: what plan, key terms, what to watch for (exit fees, price variations, lock-in)",
  "fields": [...]
}

MUST extract:
- section "tariff": ALL rates and prices — plan price, usage rates, supply charges, discounts, data allowance, call inclusions. Include units.
- section "contract": Contract length, benefit period, exit/cancellation fee, cooling-off, notice period, billing frequency, payment method, start/end dates
- section "clause": Auto-renewal, price variation clauses, switching warnings, grandfathering, hardship policy
- section "identifier": Account number, NMI/MIRN, supply address
- section "date": Contract start, end, benefit end, next review`;

const GENERIC_PROMPT = `You are parsing an Australian household document (bill, contract, letter, receipt, etc.).
Extract ALL structured data as JSON.

Return ONLY valid JSON:
{
  "provider": "company name or null",
  "category": "one of: ELECTRICITY, GAS, WATER, INTERNET, MOBILE, LANDLINE, HOME_INSURANCE, CAR_INSURANCE, HEALTH_INSURANCE, LIFE_INSURANCE, CONTENTS_INSURANCE, PET_INSURANCE, TRAVEL_INSURANCE, RENT, MORTGAGE, STRATA, COUNCIL_RATES, STREAMING, SOFTWARE, GYM, SUBSCRIPTION_BOX, VEHICLE_REGISTRATION, ROADSIDE_ASSIST, TOLL_ACCOUNT, PUBLIC_TRANSPORT, BANK_FEES, OTHER — or null",
  "documentTypes": ["BILL"|"CONTRACT"|"PDS"|"RENEWAL_NOTICE"|"CORRESPONDENCE"|"RECEIPT"|"CERTIFICATE"],
  "title": "suggested title",
  "docDate": "YYYY-MM-DD or null",
  "summary": "2-3 sentence summary",
  "fields": [
    {"label": "name", "value": "extracted value with units", "section": "tariff|contract|clause|identifier|amount|date|coverage", "importance": "high|medium|low"}
  ]
}

Section guide:
- tariff: rates, prices, premiums, charges per unit, discounts
- contract: terms, periods, fees, dates, payment info
- clause: important conditions, auto-renewal, price changes, exclusions
- identifier: account numbers, addresses, reference numbers
- amount: totals, balances, usage quantities
- date: all relevant dates
- coverage: insurance coverage items with status

For amounts include $ sign. For rates include unit (c/kWh, c/day, etc). For dates use YYYY-MM-DD.`;

/** Pick the right prompt based on detected document type and category */
function pickPrompt(docTypes: DocumentType[], category: ServiceCategory | null): string {
  const isInsurance = category && [
    'HOME_INSURANCE', 'CAR_INSURANCE', 'HEALTH_INSURANCE', 'LIFE_INSURANCE',
    'CONTENTS_INSURANCE', 'PET_INSURANCE', 'TRAVEL_INSURANCE',
  ].includes(category);

  if (isInsurance && !docTypes.includes('BILL')) return INSURANCE_PROMPT;
  if (docTypes.includes('BILL')) return BILL_PROMPT;
  if (docTypes.includes('CONTRACT')) return CONTRACT_PROMPT;
  return GENERIC_PROMPT;
}

/** Check if the document is complex (insurance/PDS) */
function isComplexDoc(docTypes: DocumentType[], category: ServiceCategory | null): boolean {
  const isInsurance = category && [
    'HOME_INSURANCE', 'CAR_INSURANCE', 'HEALTH_INSURANCE', 'LIFE_INSURANCE',
    'CONTENTS_INSURANCE', 'PET_INSURANCE', 'TRAVEL_INSURANCE',
  ].includes(category);
  return !!(isInsurance || docTypes.includes('PDS'));
}

/**
 * Parse document text using configured AI provider.
 * Returns null if API call fails (caller should fall back to regex).
 */
export async function llmParse(
  text: string,
  aiConfig: AiConfig,
  onStatus?: (status: string) => void,
  options?: {
    knownProvider?: string;
    knownCategory?: ServiceCategory;
    knownDocTypes?: DocumentType[];
  },
): Promise<LlmParseResult | null> {
  // ── Phase 1: Preprocess text ──
  onStatus?.('Cleaning text...');
  const preprocessed = preprocessText(text);

  if (preprocessed.strippedSections.length > 0) {
    console.log('[LLM Parser] Stripped sections:', preprocessed.strippedSections);
    console.log('[LLM Parser] Saved ~' + preprocessed.tokensSaved + ' tokens');
  }

  // ── Phase 2: Pick model and prompt ──
  const docTypes = options?.knownDocTypes || [];
  const category = options?.knownCategory || null;
  const isComplex = isComplexDoc(docTypes, category);

  const resolvedModel = pickAutoModel(aiConfig, isComplex);
  const config: AiConfig = { ...aiConfig, modelId: resolvedModel };

  const systemPrompt = pickPrompt(docTypes, category);

  // Build context hint if we already know the provider
  let contextHint = '';
  if (options?.knownProvider) {
    contextHint = `Context: This is a ${options.knownProvider} document`;
    if (category) contextHint += ` (${category.toLowerCase().replace(/_/g, ' ')})`;
    if (docTypes.length > 0) contextHint += `, type: ${docTypes.join(', ')}`;
    contextHint += '.\n\n';
  }

  const userMessage = contextHint + `Parse this document:\n\n${preprocessed.cleanedText}`;

  const providerLabel = PROVIDERS[config.providerId]?.label || config.providerId;
  const modelShort = resolvedModel.replace(/^(claude-|gpt-|gemini-)/, '').split('-').slice(0, 2).join(' ');
  const estimatedInputTokens = estimateTokens(systemPrompt + userMessage);
  onStatus?.(`Sending to ${providerLabel} (${modelShort}, ~${estimatedInputTokens} tokens)...`);

  try {
    const response = await callAi(config, {
      systemPrompt,
      userMessage,
      maxTokens: 4096,
    });

    // ── Track token usage ──
    const inputTokens = response.inputTokens || estimatedInputTokens;
    const outputTokens = response.outputTokens || estimateTokens(response.content);
    const estimatedCostUSD = estimateCost(config.providerId, resolvedModel, inputTokens, outputTokens);

    const tokenUsage: TokenUsage = {
      inputTokens,
      outputTokens,
      model: resolvedModel,
      provider: config.providerId,
      estimatedCostUSD,
    };

    // Save to persistent tracking
    addTokenUsage(inputTokens, outputTokens, estimatedCostUSD);

    console.log(`[LLM Parser] ${providerLabel}/${resolvedModel}: ${inputTokens} in + ${outputTokens} out = $${estimatedCostUSD.toFixed(4)}`);
    onStatus?.(`Parsing response (~$${estimatedCostUSD.toFixed(4)})...`);

    // Parse the JSON
    let jsonStr = response.content.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1]!.trim();
    }

    const parsed: LlmParseResponse = JSON.parse(jsonStr);

    // Convert to ParseResult format
    const insights: DocInsight[] = (parsed.fields || []).map(f => ({
      label: f.label,
      value: f.value,
      source: f.source,
      section: f.section,
      importance: f.importance,
    }));

    const result: LlmParseResult = {
      docTypes: parsed.documentTypes || [],
      typeScores: (parsed.documentTypes || []).map(t => ({ type: t, confidence: 0.9 })),
      suggestedTitle: parsed.title || 'Document',
      docDate: parsed.docDate || null,
      insights,
      highlights: insights.filter(i => i.importance === 'high'),
      detectedProvider: parsed.provider || options?.knownProvider || null,
      detectedCategory: parsed.category || options?.knownCategory || null,
      summary: parsed.summary || '',
      tokenUsage,
    };

    const savedPct = Math.round((1 - preprocessed.cleanedLength / preprocessed.originalLength) * 100);
    console.log(`[LLM Parser] ${insights.length} fields extracted. Text trimmed ${savedPct}% (saved ~${preprocessed.tokensSaved} tokens)`);
    onStatus?.(`Done — ${insights.length} fields ($${estimatedCostUSD.toFixed(4)}, saved ${savedPct}% text)`);

    return result;
  } catch (err) {
    console.error('[LLM Parser] Error:', err);
    onStatus?.(`AI parsing failed (${(err as Error).message}), falling back to regex...`);
    return null;
  }
}
