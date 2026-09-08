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

const BILL_PROMPT = `You are a bill-parsing engine. Given the text of an Australian utility/service bill, extract structured data as JSON.

## STRICT RULES
1. Return ONLY valid JSON — no markdown, no explanation, no text before or after.
2. Use the EXACT label names listed below. Our system matches on these labels. Wrong labels = lost data.
3. All dates MUST be YYYY-MM-DD format.
4. All dollar amounts MUST include $ sign (e.g. "$280.51").
5. Usage values MUST include the unit (e.g. "1234.5 kWh", "45.2 kL", "890 MJ").

## JSON SCHEMA
{
  "provider": "string — company name",
  "category": "ELECTRICITY | GAS | WATER | INTERNET | MOBILE | LANDLINE | HOME_INSURANCE | CAR_INSURANCE | HEALTH_INSURANCE | RENT | MORTGAGE | STRATA | COUNCIL_RATES | STREAMING | SOFTWARE | GYM | OTHER",
  "documentTypes": ["BILL"],
  "title": "Provider — Bill Mon YYYY",
  "docDate": "YYYY-MM-DD — the issue date of the bill",
  "summary": "2 sentences: billing period, total amount, notable charges or changes",
  "fields": [
    {"label": "EXACT_LABEL", "value": "extracted value", "section": "amount|tariff|date|identifier|contract|clause", "importance": "high|medium|low"}
  ]
}

## REQUIRED FIELDS — use these EXACT labels

### section: "amount" (importance: "high")
| Label              | What to extract                                | Example value    |
|--------------------|------------------------------------------------|------------------|
| Total amount       | The final amount due / total charges           | "$280.51"        |
| GST                | GST component                                  | "$25.50"         |
| New charges        | New charges this period (before payments)       | "$280.51"        |
| Previous balance   | Balance carried from previous bill             | "$0.00"          |
| Payment received   | Payments made since last bill                  | "$150.00"        |
| Solar credit       | Solar feed-in credit (if any)                  | "$12.30"         |
| Usage (kWh)        | Electricity usage — MUST include "kWh"         | "1234.5 kWh"     |
| Usage (MJ)         | Gas usage — MUST include "MJ"                  | "890 MJ"         |
| Usage (kL)         | Water usage — MUST include "kL"                | "45.2 kL"        |
| Usage days         | Number of days in the billing period           | "91"             |

### section: "date" (importance: "high")
| Label              | What to extract                                | Example value    |
|--------------------|------------------------------------------------|------------------|
| Period start       | Start of billing period (YYYY-MM-DD)           | "2025-01-15"     |
| Period end         | End of billing period (YYYY-MM-DD)             | "2025-04-15"     |
| Issue date         | Date the bill was issued                       | "2025-04-18"     |
| Due date           | Payment due date                               | "2025-05-02"     |
| Next meter read    | Next scheduled meter reading                   | "2025-07-15"     |

### section: "tariff" (importance: "medium")
Extract ALL rates/tariffs found. Use descriptive labels:
- "General usage rate", "Peak rate", "Off-peak rate", "Shoulder rate", "Controlled load rate"
- "Supply charge", "Service charge", "Daily supply charge"
- "Solar feed-in tariff", "Demand charge"
- "Discount", "Pay on time discount"
Convert $/kWh to c/kWh (multiply by 100). Always include unit: "28.5 c/kWh", "98.2 c/day"

### section: "identifier"
- "Account number", "NMI" or "MIRN", "Supply address", "Meter number"

### section: "contract"
- "Billing frequency", "Payment method", "Plan name", "Tariff type"

### section: "clause"
- Price change notices, plan expiry warnings, important terms

## EXAMPLE OUTPUT
{
  "provider": "Origin Energy",
  "category": "ELECTRICITY",
  "documentTypes": ["BILL"],
  "title": "Origin Energy — Bill Apr 2025",
  "docDate": "2025-04-18",
  "summary": "Electricity bill for 15 Jan – 15 Apr 2025. Total $280.51 for 1,234 kWh over 91 days. Includes $12.30 solar credit.",
  "fields": [
    {"label": "Total amount", "value": "$280.51", "section": "amount", "importance": "high"},
    {"label": "Usage (kWh)", "value": "1234.5 kWh", "section": "amount", "importance": "high"},
    {"label": "Usage days", "value": "91", "section": "amount", "importance": "high"},
    {"label": "Period start", "value": "2025-01-15", "section": "date", "importance": "high"},
    {"label": "Period end", "value": "2025-04-15", "section": "date", "importance": "high"},
    {"label": "Due date", "value": "2025-05-02", "section": "date", "importance": "high"},
    {"label": "General usage rate", "value": "28.5 c/kWh", "section": "tariff", "importance": "medium"},
    {"label": "Controlled load rate", "value": "18.2 c/kWh", "section": "tariff", "importance": "medium"},
    {"label": "Supply charge", "value": "98.2 c/day", "section": "tariff", "importance": "medium"},
    {"label": "Solar feed-in tariff", "value": "5.0 c/kWh", "section": "tariff", "importance": "medium"},
    {"label": "Solar credit", "value": "$12.30", "section": "amount", "importance": "medium"},
    {"label": "Account number", "value": "1234567890", "section": "identifier", "importance": "medium"},
    {"label": "NMI", "value": "6305012345", "section": "identifier", "importance": "medium"},
    {"label": "Pay on time discount", "value": "12%", "section": "tariff", "importance": "medium"}
  ]
}

IMPORTANT REMINDERS:
- "Total amount" = the final amount owed, NOT "New charges" or partial totals
- "Usage (kWh)" MUST appear for electricity bills. Look for "Total kWh", "Electricity used", "Total usage" etc.
- "Usage days" = days in billing period. Look for "X days", "billing period: X days", "supply period" etc.
- "Period start" and "Period end" = the billing period dates, NOT the issue/due dates
- For tariff tables: the "Unit Rate" column = tariff rate, the "Amount" column = period charge (not tariff)
- Extract EVERY tariff/rate you find — these are crucial for cost tracking`;

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

  // For server proxy, pass tier instead of a resolved model
  const isProxy = (aiConfig.providerId as string) === 'server-proxy';
  const resolvedModel = isProxy ? (isComplex ? 'smart' : 'fast') : pickAutoModel(aiConfig, isComplex);
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

  const providerLabel = isProxy ? 'Server AI' : (PROVIDERS[config.providerId]?.label || config.providerId);
  const modelShort = isProxy ? (isComplex ? 'smart' : 'fast') : resolvedModel.replace(/^(claude-|gpt-|gemini-)/, '').split('-').slice(0, 2).join(' ');
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
