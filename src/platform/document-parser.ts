/**
 * Robust regex-based parser that extracts structured insights from OCR/PDF text.
 * Handles messy OCR, loose formatting, multi-line values, and AU-specific patterns.
 */
import type { DocInsight, DocumentType, ServiceCategory } from '../types';

export interface ParseResult {
  docTypes: DocumentType[];
  typeScores: { type: DocumentType; confidence: number }[];
  suggestedTitle: string;
  docDate: string | null;
  insights: DocInsight[];
  highlights: DocInsight[];
  detectedProvider: string | null;
  detectedCategory: ServiceCategory | null;
}

// ─── Document type detection ───────────────────────────────

const TYPE_KEYWORDS: Record<DocumentType, string[]> = {
  BILL:           ['tax invoice', 'bill', 'amount due', 'total due', 'payment due', 'account summary', 'billing period', 'balance due', 'electricity bill', 'gas bill', 'water bill', 'your bill', 'bill summary', 'charges', 'invoice number', 'invoice date', 'new charges'],
  PDS:            ['product disclosure', 'pds', 'key fact sheet', 'target market', 'financial services guide', 'key facts'],
  CONTRACT:       ['contract', 'agreement', 'terms and conditions', 'terms & conditions', 'schedule of charges', 'energy plan', 'plan details', 'plan summary', 'market contract'],
  RENEWAL_NOTICE: ['renewal', 'renew', 'policy renewal', 'upcoming renewal', 'auto-renew', 'your plan is ending', 'plan expiry'],
  CORRESPONDENCE: ['dear customer', 'dear member', 'dear valued', 'we are writing', 'important notice', 'notification', 'we wish to advise', 'price change'],
  RECEIPT:        ['receipt', 'payment received', 'payment confirmation', 'transaction receipt', 'payment successful'],
  CERTIFICATE:    ['certificate', 'certificate of insurance', 'certificate of currency'],
};

function detectDocTypes(text: string): { type: DocumentType; confidence: number }[] {
  const lower = text.toLowerCase();
  return (Object.entries(TYPE_KEYWORDS) as [DocumentType, string[]][])
    .map(([type, keywords]) => {
      const hits = keywords.filter(k => lower.includes(k)).length;
      return { type, confidence: Math.min(hits / Math.max(keywords.length * 0.3, 1), 1) };
    })
    .filter(s => s.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
}

// ─── Dollar amount patterns ─────────────────────────────────

// Matches: $123.45, $ 123.45, $1,234.56, 123.45
const DOLLAR = /\$\s*([\d,]+\.\d{2})/;
const DOLLAR_G = /\$\s*([\d,]+\.\d{2})/g;

// Matches: 12.34c, 12.345c, 12.34 cents
const CENTS = /([\d,.]+)\s*(?:c(?:ents?)?(?:\s*\/?\s*(?:kWh|MJ|day|d|litre|L|unit))?)/i;

// ─── Insight extraction ─────────────────────────────────────

interface Pattern {
  label: string;
  regex: RegExp;
  section: DocInsight['section'];
  importance: DocInsight['importance'];
  format?: (match: RegExpMatchArray) => string;
}

// Cents-per-unit pattern: "26.433 cents per kWh" or "87.120 cents per day" or "4.5c/kWh"
const CENTS_PER = /([\d,.]+)\s*(?:cents?\s*per\s*|c\s*[/\\]\s*)(kWh|MJ|day|d|kL|litre|L|unit)/i;

const PATTERNS: Pattern[] = [
  // ══════════════════════════════════════════════════════════
  // TARIFFS — very loose matching, handles "Label X.XXX cents per unit" format
  // ══════════════════════════════════════════════════════════

  // Daily Supply charge: "Daily Supply 87.120 cents per day" or "Supply charge: 87.12c/day"
  { label: 'Supply charge', section: 'tariff', importance: 'high',
    regex: /(?:daily\s*)?supply\s*(?:charge)?[\s:]*?([\d,.]+)\s*(?:cents?\s*per\s*day|c\s*[/\\]\s*day)/i,
    format: m => m[1] + ' cents/day' },

  { label: 'Supply charge', section: 'tariff', importance: 'high',
    regex: /(?:supply|service|daily|fixed)\s*(?:charge|cost|fee|rate)[\s:]*?\$\s*([\d,.]+)\s*(?:\/?\s*day|per\s*day)/i,
    format: m => '$' + m[1] + '/day' },

  // Origin format: "Daily Supply   92 days   $1.068100   $98.27"
  { label: 'Supply charge', section: 'tariff', importance: 'high',
    regex: /daily\s*supply\s+\d+\s*days\s+\$\s*([\d.]+)/i,
    format: m => (parseFloat(m[1]!) * 100).toFixed(2) + ' cents/day' },

  // Peak rate: "Peak 48.774 cents per kWh" or Origin format "Peak ... XXX kWh   $0.641630"
  { label: 'Peak rate', section: 'tariff', importance: 'high',
    regex: /(?:^|\n|\s)peak\s+(?:rate\s*)?[\s:]*?([\d,.]+)\s*(?:cents?\s*per\s*kWh|c\s*[/\\]\s*kWh)/im,
    format: m => m[1] + ' cents/kWh' },
  // Origin table format: "Peak   ...   XXX.XXX kWh   $0.XXXXXX   $XX.XX"
  { label: 'Peak rate', section: 'tariff', importance: 'high',
    regex: /(?:^|\n)\s*peak\s+[\s\S]*?[\d,.]+\s*kWh\s+\$\s*(0\.\d{4,})/im,
    format: m => (parseFloat(m[1]!) * 100).toFixed(2) + ' cents/kWh' },

  // Off-peak: "Off-peak 16.588 cents per kWh"
  { label: 'Off-peak rate', section: 'tariff', importance: 'high',
    regex: /off[\s-]*peak\s*(?:rate)?[\s:]*?([\d,.]+)\s*(?:cents?\s*per\s*kWh|c\s*[/\\]\s*kWh)/i,
    format: m => m[1] + ' cents/kWh' },
  { label: 'Off-peak rate', section: 'tariff', importance: 'high',
    regex: /(?:^|\n)\s*off[\s-]*peak\s+[\s\S]*?[\d,.]+\s*kWh\s+\$\s*(0\.\d{4,})/im,
    format: m => (parseFloat(m[1]!) * 100).toFixed(2) + ' cents/kWh' },

  // Shoulder: "Shoulder 26.433 cents per kWh"
  { label: 'Shoulder rate', section: 'tariff', importance: 'high',
    regex: /shoulder\s*(?:rate)?[\s:]*?([\d,.]+)\s*(?:cents?\s*per\s*kWh|c\s*[/\\]\s*kWh)/i,
    format: m => m[1] + ' cents/kWh' },
  { label: 'Shoulder rate', section: 'tariff', importance: 'high',
    regex: /(?:^|\n)\s*shoulder\s+[\s\S]*?[\d,.]+\s*kWh\s+\$\s*(0\.\d{4,})/im,
    format: m => (parseFloat(m[1]!) * 100).toFixed(2) + ' cents/kWh' },

  // General/single/anytime usage rate
  { label: 'Usage rate', section: 'tariff', importance: 'high',
    regex: /(?:usage|energy|consumption|electricity|general|anytime|single)\s*(?:rate|charge|price|tariff)?[\s:]*?([\d,.]+)\s*(?:cents?\s*per\s*kWh|c\s*[/\\]\s*kWh)/i,
    format: m => m[1] + ' cents/kWh' },

  // Gas rate
  { label: 'Gas usage rate', section: 'tariff', importance: 'high',
    regex: /(?:gas|natural\s*gas)\s*(?:usage\s*)?(?:rate|charge|price)?[\s:]*?([\d,.]+)\s*(?:cents?\s*per\s*MJ|c\s*[/\\]\s*MJ)/i,
    format: m => m[1] + ' cents/MJ' },

  // Controlled load
  { label: 'Controlled load rate', section: 'tariff', importance: 'medium',
    regex: /controlled\s*load\s*(?:\d)?[\s:]*?([\d,.]+)\s*(?:cents?\s*per\s*kWh|c\s*[/\\]\s*kWh)/i,
    format: m => m[1] + ' cents/kWh' },

  // Feed-in tariff: "feed-in tariff of 3.00 c/kWh" or "3.00 cents per kWh"
  { label: 'Feed-in tariff', section: 'tariff', importance: 'high',
    regex: /feed[\s-]*in\s*(?:tariff|rate|credit|payment)?[\s:]*(?:of\s*)?([\d,.]+)\s*(?:cents?\s*per\s*kWh|c\s*[/\\]\s*kWh)/i,
    format: m => m[1] + ' cents/kWh' },

  // GreenPower: "4.500 cents per kWh"
  { label: 'GreenPower', section: 'tariff', importance: 'medium',
    regex: /green\s*power[\s\S]*?([\d,.]+)\s*(?:cents?\s*per\s*kWh|c\s*[/\\]\s*kWh)/i,
    format: m => m[1] + ' cents/kWh' },

  // Demand charge
  { label: 'Demand charge', section: 'tariff', importance: 'medium',
    regex: /demand\s*(?:charge|rate|tariff|cost)?[\s:]*?\$?\s*([\d,.]+)\s*(?:\/\s*kW|per\s*kW|\/\s*kVA)/i,
    format: m => '$' + m[1] + '/kW' },

  // Discount
  { label: 'Discount', section: 'tariff', importance: 'high',
    regex: /(\d+)\s*%\s*(?:pay[\s-]*on[\s-]*time|direct\s*debit|guaranteed|conditional|solar|loyalty|online)?\s*discount/i,
    format: m => m[1] + '% discount' },

  // Also match "discount of X%"
  { label: 'Discount', section: 'tariff', importance: 'high',
    regex: /discount\s*(?:of)?\s*(\d+)\s*%/i,
    format: m => m[1] + '% discount' },

  // Step/tier rates
  { label: 'Step 1 rate', section: 'tariff', importance: 'medium',
    regex: /(?:step|tier|block)\s*1[:\s]*(?:\$?\s*)([\d,.]+)\s*(?:c(?:ents?)?\s*[/\\]?\s*kWh|per\s*kWh)/i,
    format: m => m[1] + 'c/kWh' },
  { label: 'Step 2 rate', section: 'tariff', importance: 'medium',
    regex: /(?:step|tier|block)\s*2[:\s]*(?:\$?\s*)([\d,.]+)\s*(?:c(?:ents?)?\s*[/\\]?\s*kWh|per\s*kWh)/i,
    format: m => m[1] + 'c/kWh' },

  // Reference price / DMO
  { label: 'Reference price', section: 'tariff', importance: 'medium',
    regex: /(?:reference|default\s*market\s*offer|DMO|VDO)\s*(?:price)?[:\s]*\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },

  // Water rate per kL
  { label: 'Water usage rate', section: 'tariff', importance: 'high',
    regex: /(?:water|usage)\s*(?:rate|charge|price)?[:\s]*\$?\s*([\d,.]+)\s*(?:\/\s*kL|per\s*(?:kilo)?litre|per\s*kL)/i,
    format: m => '$' + m[1] + '/kL' },

  // Internet/monthly plan price
  { label: 'Plan price', section: 'tariff', importance: 'high',
    regex: /(?:plan|monthly)\s*(?:price|cost|charge|fee|amount)[:\s]*\$\s*([\d,.]+)\s*(?:\/?\s*(?:mo(?:nth)?|per\s*month))?/i,
    format: m => '$' + m[1] + '/month' },

  // Mobile plan: "$XX Mobile Plan" or "$XX plan"
  { label: 'Plan price', section: 'tariff', importance: 'high',
    regex: /\$\s*(\d+)\s*(?:mobile\s*)?plan/i,
    format: m => '$' + m[1] },

  // Data allowance: "12GB of data" or "50GB data"
  { label: 'Data allowance', section: 'tariff', importance: 'high',
    regex: /(\d+)\s*GB\s*(?:of\s*)?data/i,
    format: m => m[1] + ' GB' },

  // Calls: "Unlimited standard calls" or "Unlimited calls and SMS"
  { label: 'Calls & SMS', section: 'tariff', importance: 'medium',
    regex: /(unlimited\s*(?:standard\s*)?calls?\s*(?:and|&)\s*(?:SMS|text)s?)/i,
    format: m => m[1].trim() },

  // Plan expiry: "30-day expiry" or "28 day recharge"
  { label: 'Plan expiry', section: 'contract', importance: 'medium',
    regex: /(\d+)[\s-]*day\s*(?:expiry|recharge|renewal|plan)/i,
    format: m => m[1] + ' days' },

  // ── RENT ──────────────────────────────────────────────────
  { label: 'Rent amount', section: 'tariff', importance: 'high',
    regex: /(?:rent|rental)\s*(?:amount|price|cost|fee)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)\s*(?:\/?\s*(?:per\s*)?(?:week|wk|pw|p\.w\.?))/i,
    format: m => '$' + m[1] + '/week' },
  { label: 'Rent amount', section: 'tariff', importance: 'high',
    regex: /(?:rent|rental)\s*(?:amount|price|cost|fee)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)\s*(?:\/?\s*(?:per\s*)?(?:month|mo|pcm|p\.m\.?))/i,
    format: m => '$' + m[1] + '/month' },
  { label: 'Rent amount', section: 'tariff', importance: 'high',
    regex: /(?:rent|rental)\s*(?:amount|price|cost|fee)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)\s*(?:\/?\s*(?:per\s*)?(?:fortnight|fn))/i,
    format: m => '$' + m[1] + '/fortnight' },
  // Plain rent amount without frequency
  { label: 'Rent amount', section: 'tariff', importance: 'high',
    regex: /(?:weekly|fortnightly|monthly)\s*rent[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Lease start', section: 'contract', importance: 'high',
    regex: /(?:lease|tenancy)\s*(?:start|commencement|from)[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },
  { label: 'Lease end', section: 'contract', importance: 'high',
    regex: /(?:lease|tenancy)\s*(?:end|expir|until|to)[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },
  { label: 'Bond amount', section: 'tariff', importance: 'medium',
    regex: /(?:bond|security\s*deposit)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Landlord', section: 'identifier', importance: 'medium',
    regex: /(?:landlord|lessor|property\s*owner)[:\s]*([A-Z][A-Za-z\s]{2,40})/i,
    format: m => m[1].trim() },
  { label: 'Property manager', section: 'identifier', importance: 'medium',
    regex: /(?:property\s*manager|managing\s*agent|real\s*estate\s*agent)[:\s]*([A-Z][A-Za-z\s&]{2,40})/i,
    format: m => m[1].trim() },

  // ── MORTGAGE ──────────────────────────────────────────────
  { label: 'Repayment amount', section: 'tariff', importance: 'high',
    regex: /(?:repayment|instalment|installment|monthly\s*payment)\s*(?:amount)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Interest rate', section: 'tariff', importance: 'high',
    regex: /(?:interest|variable|fixed)\s*rate[:\s]*([\d.]+)\s*%\s*(?:p\.?a\.?)?/i,
    format: m => m[1] + '% p.a.' },
  { label: 'Comparison rate', section: 'tariff', importance: 'medium',
    regex: /comparison\s*rate[:\s]*([\d.]+)\s*%/i,
    format: m => m[1] + '% p.a.' },
  { label: 'Loan balance', section: 'amount', importance: 'high',
    regex: /(?:loan|outstanding|principal)\s*(?:balance|amount|remaining)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Loan term', section: 'contract', importance: 'high',
    regex: /(?:loan|mortgage)\s*(?:term|period|length)[:\s]*(\d+)\s*(?:year|yr)s?/i,
    format: m => m[1] + ' years' },
  { label: 'Offset balance', section: 'amount', importance: 'medium',
    regex: /offset\s*(?:account|balance)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },

  // ── STRATA / BODY CORPORATE ───────────────────────────────
  { label: 'Strata levy', section: 'tariff', importance: 'high',
    regex: /(?:strata|body\s*corporate|owners?\s*corporation)\s*(?:levy|fee|contribution)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Special levy', section: 'tariff', importance: 'high',
    regex: /special\s*(?:levy|assessment)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Sinking fund', section: 'tariff', importance: 'medium',
    regex: /(?:sinking|capital\s*works?)\s*fund[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Strata plan', section: 'identifier', importance: 'medium',
    regex: /(?:strata|SP)\s*(?:plan|scheme)\s*(?:no\.?|number|#)?[:\s#]*(SP\s*\d+|\d{4,10})/i,
    format: m => m[1] },
  { label: 'Lot number', section: 'identifier', importance: 'medium',
    regex: /(?:lot|unit)\s*(?:no\.?|number|#)?[:\s#]*(\d{1,5})/i,
    format: m => m[1] },

  // ── COUNCIL RATES ─────────────────────────────────────────
  { label: 'Rates amount', section: 'tariff', importance: 'high',
    regex: /(?:council|municipal|shire)\s*rates?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Rates amount', section: 'tariff', importance: 'high',
    regex: /(?:total\s*)?rates?\s*(?:payable|due|amount|levy)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Land value', section: 'amount', importance: 'medium',
    regex: /land\s*value[:\s]*\$\s*([\d,]+)/i,
    format: m => '$' + m[1] },
  { label: 'Assessment number', section: 'identifier', importance: 'high',
    regex: /(?:assessment|valuation|property)\s*(?:no\.?|number|#)[:\s#]*([\d\-/]{4,20})/i,
    format: m => m[1] },

  // ── VEHICLE REGISTRATION ──────────────────────────────────
  { label: 'Registration cost', section: 'tariff', importance: 'high',
    regex: /(?:registration|rego)\s*(?:fee|cost|charge|renewal)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'CTP premium', section: 'tariff', importance: 'high',
    regex: /(?:CTP|compulsory\s*third\s*party|green\s*slip)\s*(?:premium|cost)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Registration expiry', section: 'contract', importance: 'high',
    regex: /(?:registration|rego)\s*(?:expir|due|valid\s*(?:to|until))[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },

  // ── ROADSIDE ASSIST ───────────────────────────────────────
  { label: 'Membership fee', section: 'tariff', importance: 'high',
    regex: /(?:membership|annual)\s*(?:fee|cost|subscription|dues)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Membership level', section: 'contract', importance: 'medium',
    regex: /(?:membership|cover)\s*(?:level|type|tier)[:\s]*((?:basic|standard|classic|premium|gold|silver|bronze|platinum|elite|plus|ultimate|essentials?)(?:\s+(?:plus|extra))?)/i,
    format: m => m[1].trim() },
  { label: 'Membership number', section: 'identifier', importance: 'high',
    regex: /(?:member(?:ship)?)\s*(?:no\.?|number|#|id)[:\s#]*([\w\d\-]{4,20})/i,
    format: m => m[1] },
  { label: 'Membership expiry', section: 'contract', importance: 'high',
    regex: /(?:membership|member)\s*(?:expir|renewal|valid\s*(?:to|until))[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },

  // ── TOLL ACCOUNT ──────────────────────────────────────────
  { label: 'Account balance', section: 'amount', importance: 'high',
    regex: /(?:account|tag)\s*balance[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Toll charges', section: 'amount', importance: 'high',
    regex: /(?:total\s*)?toll\s*(?:charges?|usage|fees?)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Tag number', section: 'identifier', importance: 'high',
    regex: /(?:tag|device|transponder)\s*(?:no\.?|number|#|id)[:\s#]*([\w\d\-]{4,20})/i,
    format: m => m[1] },

  // ── STREAMING / SOFTWARE / SUBSCRIPTION ───────────────────
  { label: 'Subscription price', section: 'tariff', importance: 'high',
    regex: /(?:subscription|membership)\s*(?:price|cost|fee|amount)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)\s*(?:\/?\s*(?:per\s*)?(?:month|mo))?/i,
    format: m => '$' + m[1] + '/month' },
  { label: 'Subscription price', section: 'tariff', importance: 'high',
    regex: /\$\s*([\d,]+(?:\.\d{2})?)\s*\/?\s*(?:per\s*)?(?:month|mo|monthly)/i,
    format: m => '$' + m[1] + '/month' },
  { label: 'Subscription plan', section: 'contract', importance: 'medium',
    regex: /(?:plan|tier|package)[:\s]*((?:basic|standard|premium|family|individual|duo|student|enterprise|pro|plus|starter)(?:\s+(?:plan|tier|package))?)/i,
    format: m => m[1].trim() },

  // ── GYM / FITNESS ────────────────────────────────────────
  { label: 'Gym membership', section: 'tariff', importance: 'high',
    regex: /(?:gym|fitness|health\s*club)\s*(?:membership|fee|dues)[:\s]*\$\s*([\d,]+(?:\.\d{2})?)\s*(?:\/?\s*(?:per\s*)?(?:week|wk|fortnight|fn|month|mo))?/i,
    format: m => '$' + m[1] },
  { label: 'Joining fee', section: 'tariff', importance: 'medium',
    regex: /(?:joining|sign[\s-]*up|activation|admin)\s*fee[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },

  // ── PUBLIC TRANSPORT ─────────────────────────────────────
  { label: 'Transport pass', section: 'tariff', importance: 'high',
    regex: /(?:pass|card|opal|myki|go\s*card)\s*(?:price|cost|value|top[\s-]*up)?[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },

  // ── BANK FEES ────────────────────────────────────────────
  { label: 'Account fee', section: 'tariff', importance: 'high',
    regex: /(?:account|monthly\s*account|service)\s*(?:keeping\s*)?fee[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },
  { label: 'Card fee', section: 'tariff', importance: 'medium',
    regex: /(?:card|annual\s*card|credit\s*card)\s*(?:annual\s*)?fee[:\s]*\$\s*([\d,]+(?:\.\d{2})?)/i,
    format: m => '$' + m[1] },

  // ── HEALTH INSURANCE ───────────────────────────────────────
  // Hospital excess
  { label: 'Hospital excess', section: 'tariff', importance: 'high',
    regex: /(?:hospital\s*)?excess[:\s]*\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*person|per\s*admission)?/i,
    format: m => '$' + m[1] },
  // Excess from product name like "$750 Excess"
  { label: 'Hospital excess', section: 'tariff', importance: 'high',
    regex: /\$\s*(\d+)\s*excess/i,
    format: m => '$' + m[1] },
  // Max excess per year
  { label: 'Max excess per year (single)', section: 'tariff', importance: 'medium',
    regex: /\$\s*([\d,]+)\s*(?:is\s*)?(?:the\s*)?maximum\s*(?:you\s*will\s*pay|payable).*?(?:single|per\s*person)/i,
    format: m => '$' + m[1] },
  { label: 'Max excess per year (couple)', section: 'tariff', importance: 'medium',
    regex: /\$\s*([\d,]+)\s*(?:is\s*)?(?:the\s*)?maximum\s*(?:you\s*will\s*pay|payable).*?(?:couple|family)/i,
    format: m => '$' + m[1] },

  // Health insurance cover type / product name — must look like "Name (Tier)" or "Name Tier"
  { label: 'Product name', section: 'contract', importance: 'high',
    regex: /(?:product|cover|plan)\s*(?:name|type|:)\s*[:\-–]?\s*(.{3,50}(?:basic|bronze|silver|gold|top|hospital|extras|combined|plus|premium)\b[^.\n]{0,20})/im,
    format: m => m[1].trim() },

  // Ambulance cover
  { label: 'Ambulance', section: 'coverage', importance: 'high',
    regex: /((?:unlimited|included|covered)\s*(?:emergency\s*)?ambulance[^.]{0,80})/i,
    format: m => m[1].trim().slice(0, 120) },

  // Extras limits — therapeutic
  { label: 'Physio benefit', section: 'tariff', importance: 'medium',
    regex: /physiotherapy[^$]*?\$\s*([\d,]+)\s*(?:per\s*(?:consultation|visit|consult))/i,
    format: m => '$' + m[1] + '/consultation' },
  { label: 'Dental limit', section: 'tariff', importance: 'medium',
    regex: /(?:combined\s*)?(?:dental\s*)?limit\s*\$\s*([\d,]+)\s*per\s*person/i,
    format: m => '$' + m[1] + '/year' },
  { label: 'Therapeutic limit', section: 'tariff', importance: 'medium',
    regex: /(?:combined\s*)?(?:therapeutic\s*)?limit\s*\$\s*([\d,]+)\s*per\s*person/i,
    format: m => '$' + m[1] + '/year' },
  { label: 'Optical limit', section: 'tariff', importance: 'medium',
    regex: /(?:optical|eyewear)\s*(?:limit|benefit)[:\s]*\$\s*([\d,]+)/i,
    format: m => '$' + m[1] + '/year' },

  // Hospital cover tier (Basic/Bronze/Silver/Gold)
  { label: 'Hospital tier', section: 'contract', importance: 'high',
    regex: /(?:hospital\s*)?(?:cover\s*)?tier[:\s]*(basic|bronze|silver|gold|basic\s*plus)/i,
    format: m => m[1].trim() },

  // Membership type
  { label: 'Membership type', section: 'contract', importance: 'medium',
    regex: /(?:membership|policy)\s*type[:\s]*(single|couple|family|single\s*parent)/i,
    format: m => m[1].trim() },

  // Waiting periods
  { label: 'General waiting period', section: 'contract', importance: 'medium',
    regex: /(?:general|standard)\s*waiting\s*period[:\s]*(\d+\s*(?:month|day|week)s?)/i,
    format: m => m[1] },
  { label: 'Pre-existing waiting period', section: 'contract', importance: 'high',
    regex: /pre[\s-]*existing\s*(?:condition\s*)?(?:waiting\s*period)?[:\s]*(\d+\s*(?:month|year)s?)/i,
    format: m => m[1] },
  { label: 'Pregnancy waiting period', section: 'contract', importance: 'high',
    regex: /pregnancy\s*(?:and\s*birth\s*)?(?:waiting\s*period)?[:\s]*(\d+\s*(?:month|year)s?)/i,
    format: m => m[1] },

  // Premium/insurance premium — "Total premium" first (most important)
  { label: 'Total premium', section: 'tariff', importance: 'high',
    regex: /total\s*premium\s*\^?\s*\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },

  // Car premium — grab the LAST dollar amount on the line (= Total column in tables)
  { label: 'Car premium', section: 'tariff', importance: 'high',
    regex: /car\s*premium[\s\S]*?\$\s*([\d,.]+)\s*$/im,
    format: m => '$' + m[1] },

  // Accident hire car premium — last dollar on line
  { label: 'Accident hire car premium', section: 'tariff', importance: 'medium',
    regex: /accident\s*hire\s*car\s*premium[\s\S]*?\$\s*([\d,.]+)\s*$/im,
    format: m => '$' + m[1] },

  // Generic premium (fallback) — prefer "total" or "annual" premium
  { label: 'Premium', section: 'tariff', importance: 'high',
    regex: /(?:annual|yearly|monthly|quarterly)\s*premium[:\s]*\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },

  // Insurance — excess / deductible
  { label: 'Basic excess', section: 'tariff', importance: 'high',
    regex: /(?:basic|standard|your)\s*excess[:\s]*\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },
  { label: 'Excess', section: 'tariff', importance: 'high',
    regex: /excess[:\s]*\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },
  { label: 'Voluntary excess', section: 'tariff', importance: 'medium',
    regex: /voluntary\s*(?:excess|deductible)[:\s]*\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },
  { label: 'Age excess', section: 'tariff', importance: 'medium',
    regex: /(?:age|young\s*driver|under[\s-]*25)\s*excess[:\s]*\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },

  // Insurance — sum insured / cover amount
  { label: 'Sum insured', section: 'tariff', importance: 'high',
    regex: /(?:sum\s*insured|insured\s*(?:amount|value)|(?:agreed|market)\s*value|cover\s*amount)[:\s]*\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },

  // Insurance — cover type (capture known values only)
  { label: 'Cover type', section: 'contract', importance: 'high',
    regex: /(?:type\s*of\s*cover|cover\s*type|level\s*of\s*cover)\s{2,}(comprehensive|third\s*party[\s,]*fire\s*(?:and|&)\s*theft|third\s*party\s*property(?:\s*only)?|CTP|compulsory\s*third\s*party)/i,
    format: m => m[1].trim() },

  // Insurance — vehicle details
  { label: 'Vehicle', section: 'identifier', importance: 'high',
    regex: /(?:vehicle|car|motor\s*vehicle)\s*(?:description|details?)?[:\s]*(\d{4}\s+[A-Za-z][^\n]{5,40})/i,
    format: m => m[1].trim() },
  { label: 'Registration', section: 'identifier', importance: 'high',
    regex: /(?:registration|rego)\s*(?:no\.?|number|#|plate)[\s:]+([A-Z][A-Z0-9]{1,6}[0-9A-Z])\b/i,
    format: m => m[1].toUpperCase() },

  // Insurance — coverage items (Included / Not included / Optional)
  { label: 'Accident hire car', section: 'coverage', importance: 'high',
    regex: /accident\s*hire\s*car\s{2,}(included|not\s*included|optional)/i,
    format: m => m[1].trim() },
  { label: 'Choice of repairer', section: 'coverage', importance: 'medium',
    regex: /choice\s*of\s*repairer\s{2,}(included|not\s*included|optional)/i,
    format: m => m[1].trim() },
  { label: 'Reduced window glass excess', section: 'coverage', importance: 'medium',
    regex: /reduced\s*window\s*glass\s*excess\s{2,}(included|not\s*included|optional)/i,
    format: m => m[1].trim() },
  { label: 'Roadside assistance', section: 'coverage', importance: 'high',
    regex: /roadside\s*(?:assist(?:ance)?|help)\s{2,}(included|not\s*included|optional)/i,
    format: m => m[1].trim() },
  { label: 'New car replacement', section: 'coverage', importance: 'high',
    regex: /new\s*(?:car|vehicle)\s*replacement\s{2,}(included|not\s*included|optional)/i,
    format: m => m[1].trim() },

  // Insurance — car insured for (Market Value / Agreed Value)
  { label: 'Car insured for', section: 'coverage', importance: 'high',
    regex: /car\s*insured\s*for\s{2,}(market\s*value|agreed\s*value)/i,
    format: m => m[1].trim() },

  // Insurance — window glass excess
  { label: 'Window glass excess', section: 'tariff', importance: 'medium',
    regex: /window\s*glass\s*(?:only|excess)?\s{2,}\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },

  // Insurance — product / plan name (stop capture at double-space boundary)
  { label: 'Product', section: 'contract', importance: 'high',
    regex: /product\s{2,}((?:[\w-]+(?:\s(?!\s))?){1,10}(?:insurance|policy|cover|plan)(?:\s*[-–]\s*(?:[\w]+(?:\s(?!\s))?){0,4})?)/i,
    format: m => m[1].trim().slice(0, 60) },

  // Insurance — period of insurance
  { label: 'Policy start', section: 'contract', importance: 'high',
    regex: /(?:start\s*date|(?:policy|period)\s*(?:of\s*insurance\s*)?start|commencement)\s{2,}([\d]{1,2}\s+\w+\s+\d{4})/i,
    format: m => m[1].trim() },
  { label: 'Policy expiry', section: 'contract', importance: 'high',
    regex: /(?:expiry\s*date|(?:policy|period)\s*(?:of\s*insurance\s*)?(?:end|expir)|renewal\s*date)\s{2,}([\d]{1,2}\s+\w+\s+\d{4})/i,
    format: m => m[1].trim() },

  // Insurance — permitted use (capture known values only)
  { label: 'Permitted use', section: 'coverage', importance: 'medium',
    regex: /(?:permitted|allowed)\s*use\s*(?:of\s*car)?\s{2,}((?:private|business|rideshare)(?:\s+and\s+commuting)?)/i,
    format: m => m[1].trim() },

  // Insurance — kilometres per year (capture "Less/More than X,XXX per year" or a number)
  { label: 'Kilometres per year', section: 'coverage', importance: 'medium',
    regex: /kilometres?\s*per\s*year\s{2,}((?:less|more|up\s*to|under|over)\s+than\s+[\d,]+\s*(?:per\s*year|km)?|[\d,]+(?:\s*km)?)/i,
    format: m => m[1].trim() },

  // Insurance — parking method (capture known values only)
  { label: 'Parking method', section: 'coverage', importance: 'low',
    regex: /method\s*of\s*parking\s{2,}((?:in\s+a\s+)?(?:locked\s+(?:garage|compound)|carport|driveway|on\s+(?:the\s+)?street|secure\s+parking))/i,
    format: m => m[1].trim() },

  // Insurance — additional excess for unlisted/young drivers
  { label: 'Unlisted driver excess', section: 'tariff', importance: 'medium',
    regex: /not\s*listed\s*as\s*a\s*driver[\s\S]{0,30}\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },
  { label: 'Inexperienced driver excess', section: 'tariff', importance: 'medium',
    regex: /not\s*held\s*a\s*full[\s\S]{0,50}\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },
  { label: 'Excess km exceeded', section: 'tariff', importance: 'medium',
    regex: /kilometres?\s*(?:per\s*year\s*)?(?:have\s*been\s*)?exceeded[\s\S]{0,30}\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },

  // ══════════════════════════════════════════════════════════
  // CONTRACT TERMS
  // ══════════════════════════════════════════════════════════

  { label: 'Contract length', section: 'contract', importance: 'high',
    regex: /(?:contract|agreement|plan|benefit)\s*(?:length|period|duration|term|type)[:\s]*([\d]+\s*(?:month|year|week|day)s?)/i,
    format: m => m[1] },

  { label: 'Benefit period', section: 'contract', importance: 'high',
    regex: /benefit\s*(?:period|end|expir)[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },

  { label: 'Cooling-off period', section: 'contract', importance: 'medium',
    regex: /cooling[\s-]*off\s*(?:period|right)?[:\s]*([\d]+\s*(?:day|business\s*day|working\s*day)s?)/i,
    format: m => m[1] },

  { label: 'Notice period', section: 'contract', importance: 'medium',
    regex: /(?:notice|cancellation)\s*(?:period|required)?[:\s]*([\d]+\s*(?:day|week|month)s?)/i,
    format: m => m[1] },

  { label: 'Exit fee', section: 'contract', importance: 'high',
    regex: /(?:exit|early[\s-]*termination|break|cancellation|disconnect)\s*(?:fee|charge|cost|penalty)[:\s]*\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },

  { label: 'Late payment fee', section: 'contract', importance: 'medium',
    regex: /late\s*(?:payment)?\s*(?:fee|charge|penalty|interest)[\s\S]{0,80}?\$\s*([\d,.]+)/i,
    format: m => '$' + m[1] },

  { label: 'Payment terms', section: 'contract', importance: 'medium',
    regex: /(?:payment|pay(?:able)?)\s*(?:due|terms?|within|by)[:\s]*([\d]+\s*(?:day|business\s*day)s?)/i,
    format: m => m[1] },

  { label: 'Billing frequency', section: 'contract', importance: 'medium',
    regex: /(?:billed?|billing|invoiced?)\s*(?:every|each|frequency)?[:\s]*(monthly|quarterly|annually|yearly|weekly|fortnightly|half[\s-]*yearly|bi[\s-]*monthly)/i,
    format: m => m[1] },

  { label: 'Payment method', section: 'contract', importance: 'low',
    regex: /(?:payment\s*method|pay\s*by|pay\s*via)[:\s]*(direct\s*debit|credit\s*card|bpay|bank\s*transfer|eft)/i,
    format: m => m[1] },

  // ══════════════════════════════════════════════════════════
  // CLAUSES — capture surrounding text for context
  // ══════════════════════════════════════════════════════════

  { label: 'Auto-renewal', section: 'clause', importance: 'high',
    regex: /((?:auto|automatic)[\s-]*(?:renew|renewal)[^.]{0,100}\.?)/i,
    format: m => m[1].trim().slice(0, 120) },

  { label: 'Price variation', section: 'clause', importance: 'high',
    regex: /((?:price|rate|tariff|charge)\s*(?:may|can|will|subject\s*to)\s*(?:vary|change|increase|be\s*adjusted)[^.]{0,100}\.?)/i,
    format: m => m[1].trim().slice(0, 120) },

  { label: 'Hardship', section: 'clause', importance: 'medium',
    regex: /(?:hardship\s*(?:policy|program|plan|arrangement|application)|(?:apply|eligible)\s+for\s+(?:a\s+)?hardship)\s*[^.]{0,100}\.?/i,
    format: m => m[0].trim().slice(0, 120) },

  { label: 'Concession', section: 'clause', importance: 'medium',
    regex: /(?:concession\s*(?:card|holder|discount|amount|applied|rebate\s*applied)|(?:you\s*(?:are|have)\s+(?:a\s+)?concession))\s*[^.]{0,80}\.?/i,
    format: m => m[0].trim().slice(0, 120) },

  // Plan change / discontinuation
  { label: 'Plan change', section: 'clause', importance: 'high',
    regex: /((?:will\s*no\s*longer\s*be\s*available|plan\s*(?:will\s*be\s*)?(?:discontinued|removed|retired|changed))[^.]{0,120}\.?)/i,
    format: m => m[1].trim().slice(0, 150) },

  // Grandfathering: "keep renewing ... until ..."
  { label: 'Grandfathered until', section: 'clause', importance: 'high',
    regex: /((?:keep\s*renewing|continue\s*(?:to\s*)?(?:use|renew|enjoy))[^.]{0,120}\.?)/i,
    format: m => m[1].trim().slice(0, 150) },

  // Change effective date: "from DD Month YYYY" at start of sentence
  { label: 'Change effective date', section: 'contract', importance: 'high',
    regex: /(?:from|effective|starting|as\s*(?:of|at))\s+(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i,
    format: m => m[1] },

  // "no longer available" / switching warning
  { label: 'Switching warning', section: 'clause', importance: 'high',
    regex: /((?:if\s*you\s*change|if\s*you\s*switch)[^.]{0,120}\.?)/i,
    format: m => m[1].trim().slice(0, 150) },

  // ══════════════════════════════════════════════════════════
  // IDENTIFIERS
  // ══════════════════════════════════════════════════════════

  { label: 'NMI', section: 'identifier', importance: 'high',
    regex: /(?:NMI|national\s*meter(?:ing)?\s*identifier?)[:\s#]*(\d{10,11})/i,
    format: m => m[1] },

  { label: 'MIRN', section: 'identifier', importance: 'high',
    regex: /(?:MIRN|DPI|meter\s*(?:installation|number|no|#))[:\s#]*([\d]{5,15})/i,
    format: m => m[1] },

  { label: 'Account number', section: 'identifier', importance: 'high',
    regex: /(?:account|acc(?:t)?|customer|a\/c)\s*(?:no\.?|number|num|#|ref)?[:\s#]*([\d][\d\s\-]{3,20}[\d])/i,
    format: m => m[1].replace(/\s+/g, '') },

  { label: 'Customer reference', section: 'identifier', importance: 'medium',
    regex: /(?:customer|client|member)\s*(?:reference|ref|id|number|no)[:\s#]*([\w\d\-]{4,20})/i,
    format: m => m[1] },

  { label: 'ABN', section: 'identifier', importance: 'low',
    regex: /ABN[:\s]*([\d][\d\s]{9,14}[\d])/i,
    format: m => m[1].replace(/\s+/g, ' ').trim() },

  { label: 'Policy number', section: 'identifier', importance: 'high',
    regex: /(?:policy|certificate)\s*(?:no\.?|number|#)[:\s#]*([\w\d\-\/]{4,25})/i,
    format: m => m[1] },

  { label: 'Supply address', section: 'identifier', importance: 'medium',
    regex: /(?:supply|service|property|premise|installation)\s*address[:\s]+(\d+[^\n]{5,75})/i,
    format: m => m[1].trim() },

  // ══════════════════════════════════════════════════════════
  // AMOUNTS
  // ══════════════════════════════════════════════════════════

  { label: 'Total amount', section: 'amount', importance: 'high',
    regex: /(?:total\s*(?:amount|charges?|due|payable|owing|new\s*charges|this\s*bill)|amount\s*(?:due|payable|owing)|balance\s*due|you\s*(?:owe|need\s*to\s*pay))[:\s]*\$\s*([\d,]+\.\d{2})/i,
    format: m => '$' + m[1] },

  // Also try plain "total $X"
  { label: 'Total amount', section: 'amount', importance: 'high',
    regex: /total[:\s]+\$\s*([\d,]+\.\d{2})/i,
    format: m => '$' + m[1] },

  { label: 'GST', section: 'amount', importance: 'low',
    regex: /(?:GST|goods\s*(?:and|&)\s*services\s*tax)[:\s]*\$\s*([\d,]+\.\d{2})/i,
    format: m => '$' + m[1] },

  { label: 'Previous balance', section: 'amount', importance: 'low',
    regex: /(?:previous|last|opening)\s*(?:balance|charges?|bill)[:\s]*\$\s*([\d,]+\.\d{2})/i,
    format: m => '$' + m[1] },

  { label: 'Payment received', section: 'amount', importance: 'low',
    regex: /(?:payment|amount)\s*(?:received|paid|credited)[:\s]*-?\s*\$\s*([\d,]+\.\d{2})/i,
    format: m => '$' + m[1] },

  { label: 'New charges', section: 'amount', importance: 'medium',
    regex: /(?:new|current)\s*(?:charges?|costs?)[:\s]*\$\s*([\d,]+\.\d{2})/i,
    format: m => '$' + m[1] },

  // Electricity/gas/water usage — multiple patterns for different bill formats
  { label: 'Usage (kWh)', section: 'amount', importance: 'medium',
    regex: /(?:total\s*)?(?:usage|consumption|energy\s*used)[:\s]*([\d,.]+)\s*kWh/i,
    format: m => m[1] + ' kWh' },
  // Origin format: "Total kWh   797.800"
  { label: 'Usage (kWh)', section: 'amount', importance: 'medium',
    regex: /total\s*kWh\s+([\d,.]+)/i,
    format: m => m[1] + ' kWh' },

  { label: 'Usage (MJ)', section: 'amount', importance: 'medium',
    regex: /(?:total\s*)?(?:usage|consumption|gas\s*used)[:\s]*([\d,.]+)\s*MJ/i,
    format: m => m[1] + ' MJ' },
  { label: 'Usage (MJ)', section: 'amount', importance: 'medium',
    regex: /total\s*MJ\s+([\d,.]+)/i,
    format: m => m[1] + ' MJ' },

  { label: 'Usage (kL)', section: 'amount', importance: 'medium',
    regex: /(?:total\s*)?(?:usage|consumption|water\s*used)[:\s]*([\d,.]+)\s*kL/i,
    format: m => m[1] + ' kL' },
  { label: 'Usage (kL)', section: 'amount', importance: 'medium',
    regex: /total\s*kL\s+([\d,.]+)/i,
    format: m => m[1] + ' kL' },

  // Usage days: "92 days in this period" or "(92 days)" or "Billing period: ... (92 days)"
  { label: 'Usage days', section: 'amount', importance: 'low',
    regex: /(?:billing\s*period|in\s*(?:this|the|your)\s*(?:period|bill))[^)]*?\(?\s*(\d+)\s*days?\s*\)?/i,
    format: m => m[1] + ' days' },
  { label: 'Usage days', section: 'amount', importance: 'low',
    regex: /\(\s*(\d+)\s*days?\s*\)/i,
    format: m => m[1] + ' days' },

  { label: 'Solar export', section: 'amount', importance: 'medium',
    regex: /(?:solar|export|feed[\s-]*in)\s*(?:credit|export)?[:\s]*-?\s*\$\s*([\d,]+\.\d{2})/i,
    format: m => '$' + m[1] },

  // ══════════════════════════════════════════════════════════
  // DATES
  // ══════════════════════════════════════════════════════════

  { label: 'Issue date', section: 'date', importance: 'medium',
    regex: /(?:issue|invoice|statement|bill)\s*date[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },

  { label: 'Due date', section: 'date', importance: 'high',
    regex: /(?:due|pay(?:ment|able)?)\s*(?:by\s*)?date[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },

  // "Pay by" without "date"
  { label: 'Due date', section: 'date', importance: 'high',
    regex: /pay\s*by[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },

  { label: 'Period start', section: 'date', importance: 'medium',
    regex: /(?:period|billing|from|service)\s*(?:from|start|begins?)?[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },

  { label: 'Period end', section: 'date', importance: 'medium',
    regex: /(?:period|billing)?\s*(?:to|end|until)[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },

  // Date range: "01 Jul 2025 to 30 Sep 2025" or "01/07/25 - 30/09/25"
  { label: 'Billing period', section: 'date', importance: 'medium',
    regex: /([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})\s*(?:to|–|—|-)\s*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] + ' to ' + m[2] },

  { label: 'Next meter read', section: 'date', importance: 'low',
    regex: /(?:next|scheduled)\s*(?:meter\s*)?read[:\s]*([\d]{1,2}[\s/\-](?:\w{3,9}|[\d]{1,2})[\s/\-][\d]{2,4})/i,
    format: m => m[1] },
];

function extractInsights(text: string): DocInsight[] {
  const insights: DocInsight[] = [];
  const seenLabels = new Set<string>();

  // Run regex patterns
  for (const p of PATTERNS) {
    if (seenLabels.has(p.label)) continue;

    const match = p.regex.exec(text);
    if (match) {
      seenLabels.add(p.label);
      const value = p.format ? p.format(match) : match[1]?.trim() || match[0].trim();

      // Find source line
      const lines = text.split('\n');
      const sourceLine = lines.find(l => l.includes(match[0]?.slice(0, 30))) || match[0];

      insights.push({
        label: p.label,
        value,
        source: sourceLine.trim().slice(0, 150),
        section: p.section,
        importance: p.importance,
      });
    }
  }

  // ─── Multi-line look-ahead ────────────────────────────────
  // PDF/OCR text often has labels on one line and values on the next
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    const next = lines[i + 1]!;
    const lower = line.toLowerCase();

    // Supply charge label → value on next line
    if (/supply\s*charge/i.test(line) && !seenLabels.has('Supply charge')) {
      const valMatch = next.match(/(?:\$?\s*)([\d,.]+)\s*(?:c(?:ents?)?\s*[/\\]?\s*(?:day|d)|per\s*day|\/\s*day|\$\s*\/\s*day)/i);
      if (valMatch) {
        seenLabels.add('Supply charge');
        insights.push({ label: 'Supply charge', value: valMatch[1] + 'c/day', source: `${line} / ${next}`, section: 'tariff', importance: 'high' });
      }
    }

    // Usage rate label → value on next line
    if (/(?:usage|energy|consumption|electricity)\s*(?:rate|charge|price)?$/i.test(line) && !seenLabels.has('Usage rate')) {
      const valMatch = next.match(/(?:\$?\s*)([\d,.]+)\s*(?:c(?:ents?)?\s*[/\\]?\s*kWh|per\s*kWh)/i);
      if (valMatch) {
        seenLabels.add('Usage rate');
        insights.push({ label: 'Usage rate', value: valMatch[1] + 'c/kWh', source: `${line} / ${next}`, section: 'tariff', importance: 'high' });
      }
    }

    // "Total" on one line, dollar amount on next
    if (/^total$/i.test(lower) && !seenLabels.has('Total amount')) {
      const valMatch = next.match(/\$\s*([\d,]+\.\d{2})/);
      if (valMatch) {
        seenLabels.add('Total amount');
        insights.push({ label: 'Total amount', value: '$' + valMatch[1], source: `${line} / ${next}`, section: 'amount', importance: 'high' });
      }
    }

    // "Account" label → number on next line
    if (/^(?:account|acc(?:ount)?\s*(?:no|number|#)?)\s*$/i.test(lower) && !seenLabels.has('Account number')) {
      const valMatch = next.match(/([\d][\d\s\-]{3,20}[\d])/);
      if (valMatch) {
        seenLabels.add('Account number');
        insights.push({ label: 'Account number', value: valMatch[1].replace(/\s+/g, ''), source: `${line} / ${next}`, section: 'identifier', importance: 'high' });
      }
    }

    // Generic: label with colon and no value → value on next line
    if (line.endsWith(':') && !seenLabels.has(line.slice(0, -1).trim())) {
      const labelCandidate = line.slice(0, -1).trim();
      // Only capture if next line looks like a value (has a dollar amount, number, or date)
      const dollarMatch = next.match(/^\$\s*([\d,]+\.\d{2})/);
      if (dollarMatch && labelCandidate.length <= 30) {
        insights.push({
          label: labelCandidate,
          value: '$' + dollarMatch[1],
          source: `${line} / ${next}`,
          section: 'amount',
          importance: 'medium',
        });
        seenLabels.add(labelCandidate);
      }
    }
  }

  // ─── Fallback: scan for all dollar amounts with labels ────
  // For table rows with multiple $amounts, grab the LAST one (usually "Total" column)
  // Limit to 6 entries to avoid noise from detailed bill line items
  const FALLBACK_SKIP = new Set(['and', 'the', 'for', 'from', 'your', 'this', 'that', 'with',
    'per', 'inc', 'gst', 'total', 'subtotal', 'peak', 'shoulder', 'off',
    'daily supply', 'daily', 'supply']);
  let fallbackCount = 0;
  for (const line of lines) {
    if (fallbackCount >= 6) break;
    // Skip bill line-item table rows that contain kWh/MJ/kL/days — those are per-period charges, not tariffs
    if (/kWh|MJ|kL|\d+\s*days/i.test(line)) continue;
    // Match: "Label text  $X.XX  $Y.YY  $Z.ZZ" — we want the last dollar amount
    const labelMatch = line.match(/^([A-Za-z][A-Za-z\s&/]{2,35}?)\s{2,}/);
    if (labelMatch) {
      const label = labelMatch[1]!.trim();
      const labelLower = label.toLowerCase();
      // Skip already-seen, too-short, or generic/energy-specific labels
      if (!seenLabels.has(label) && label.length >= 4 && !FALLBACK_SKIP.has(labelLower)) {
        // Find ALL dollar amounts on this line, take the last one
        const allDollars = [...line.matchAll(/\$\s*([\d,]+\.\d{2})/g)];
        if (allDollars.length > 0) {
          const lastAmount = allDollars[allDollars.length - 1]![1];
          seenLabels.add(label);
          insights.push({
            label,
            value: '$' + lastAmount,
            source: line.trim().slice(0, 150),
            section: 'amount',
            importance: 'low',
          });
          fallbackCount++;
        }
      }
    }
  }

  // ─── Fallback: scan for "Label   Included/Not included" (insurance options) ──
  for (const line of lines) {
    const optMatch = line.match(/^([A-Za-z][A-Za-z\s&/'()-]{2,40}?)\s{2,}(Included|Not\s*included|Optional|Covered|Not\s*covered|Excluded|Restricted)\s*$/i);
    if (optMatch) {
      const label = optMatch[1]!.trim();
      if (!seenLabels.has(label) && label.length >= 3) {
        seenLabels.add(label);
        insights.push({
          label,
          value: optMatch[2]!.trim(),
          source: line.trim().slice(0, 150),
          section: 'coverage',
          importance: /not\s*included|not\s*covered|excluded/i.test(optMatch[2]!) ? 'medium' : 'high',
        });
      }
    }
  }

  // NOTE: Generic key-value fallback scanner removed — it captured too much noise
  // from PDS documents (table rows, explanatory text, personal info).
  // All important fields are now captured by specific regex patterns above.

  console.log('[Parser] Extracted', insights.length, 'insights from', lines.length, 'lines');
  return insights;
}

// ─── Date extraction ────────────────────────────────────────

function extractDate(text: string): string | null {
  const patterns = [
    // "Issue date: 15 Aug 2026" or "Invoice date: 15/08/2026"
    /(?:issue|invoice|statement|bill|dated?)\s*(?:date)?[:\s]*([\d]{1,2}[\s/\-](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*[\s/\-][\d]{2,4})/i,
    /(?:issue|invoice|statement|bill|dated?)\s*(?:date)?[:\s]*([\d]{1,2}[\s/\-][\d]{1,2}[\s/\-][\d]{2,4})/i,
    // Loose: any "DD Mon YYYY" in the first 30 lines
    /([\d]{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+[\d]{4})/i,
    /([\d]{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+[\d]{4})/i,
  ];

  const searchArea = text.split('\n').slice(0, 30).join('\n');

  for (const p of patterns) {
    const m = p.exec(searchArea);
    if (m) {
      const d = new Date(m[1]!);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      // Try DD/MM/YYYY AU format
      const parts = m[1]!.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (parts) {
        const year = parts[3]!.length === 2 ? '20' + parts[3] : parts[3];
        const d2 = new Date(`${year}-${parts[2]!.padStart(2, '0')}-${parts[1]!.padStart(2, '0')}`);
        if (!isNaN(d2.getTime())) return d2.toISOString().slice(0, 10);
      }
    }
  }
  return null;
}

// ─── Provider & category detection ──────────────────────────

interface ProviderInfo {
  name: string;
  aliases: string[];
  categories: ServiceCategory[];
}

const KNOWN_PROVIDERS: ProviderInfo[] = [
  // Energy
  { name: 'Origin Energy',       aliases: ['origin', 'origin energy'],                       categories: ['ELECTRICITY', 'GAS'] },
  { name: 'AGL',                 aliases: ['agl'],                                           categories: ['ELECTRICITY', 'GAS'] },
  { name: 'EnergyAustralia',     aliases: ['energyaustralia', 'energy australia'],            categories: ['ELECTRICITY', 'GAS'] },
  { name: 'Alinta Energy',       aliases: ['alinta'],                                        categories: ['ELECTRICITY', 'GAS'] },
  { name: 'Red Energy',          aliases: ['red energy'],                                    categories: ['ELECTRICITY', 'GAS'] },
  { name: 'Simply Energy',       aliases: ['simply energy'],                                 categories: ['ELECTRICITY', 'GAS'] },
  { name: 'Powershop',           aliases: ['powershop'],                                     categories: ['ELECTRICITY', 'GAS'] },
  { name: 'Lumo Energy',         aliases: ['lumo'],                                          categories: ['ELECTRICITY', 'GAS'] },
  { name: 'Momentum Energy',     aliases: ['momentum'],                                      categories: ['ELECTRICITY', 'GAS'] },
  { name: 'Sumo Power',          aliases: ['sumo'],                                          categories: ['ELECTRICITY', 'GAS'] },
  { name: 'Dodo Power & Gas',    aliases: ['dodo'],                                          categories: ['ELECTRICITY', 'GAS', 'INTERNET'] },
  { name: 'ActewAGL',            aliases: ['actewagl'],                                      categories: ['ELECTRICITY', 'GAS'] },
  // Networks (electricity only)
  { name: 'Ausgrid',             aliases: ['ausgrid'],                                       categories: ['ELECTRICITY'] },
  { name: 'Jemena',              aliases: ['jemena'],                                        categories: ['ELECTRICITY', 'GAS'] },
  { name: 'Citipower',           aliases: ['citipower'],                                     categories: ['ELECTRICITY'] },
  { name: 'Powercor',            aliases: ['powercor'],                                      categories: ['ELECTRICITY'] },
  // Telecom
  { name: 'Aussie Broadband',    aliases: ['aussie broadband', 'aussiebroadband'],            categories: ['INTERNET'] },
  { name: 'Telstra',             aliases: ['telstra'],                                       categories: ['INTERNET', 'MOBILE', 'LANDLINE'] },
  { name: 'Optus',               aliases: ['optus'],                                         categories: ['INTERNET', 'MOBILE'] },
  { name: 'TPG',                 aliases: ['tpg'],                                           categories: ['INTERNET'] },
  { name: 'Vodafone',            aliases: ['vodafone'],                                      categories: ['MOBILE'] },
  { name: 'iiNet',               aliases: ['iinet'],                                         categories: ['INTERNET'] },
  { name: 'Internode',           aliases: ['internode'],                                     categories: ['INTERNET'] },
  { name: 'Belong',              aliases: ['belong'],                                        categories: ['INTERNET', 'MOBILE'] },
  { name: 'ALDI Mobile',         aliases: ['aldi mobile'],                                    categories: ['MOBILE'] },
  { name: 'Boost Mobile',        aliases: ['boost mobile', 'boost'],                          categories: ['MOBILE'] },
  { name: 'Amaysim',             aliases: ['amaysim'],                                        categories: ['MOBILE'] },
  { name: 'Woolworths Mobile',   aliases: ['woolworths mobile'],                               categories: ['MOBILE'] },
  { name: 'Coles Mobile',        aliases: ['coles mobile'],                                    categories: ['MOBILE'] },
  { name: 'Lebara',              aliases: ['lebara'],                                         categories: ['MOBILE'] },
  { name: 'Lycamobile',          aliases: ['lycamobile'],                                     categories: ['MOBILE'] },
  { name: 'Circles.Life',        aliases: ['circles.life', 'circles life'],                   categories: ['MOBILE'] },
  { name: 'Kogan Mobile',        aliases: ['kogan mobile', 'kogan'],                          categories: ['MOBILE'] },
  { name: 'Spintel',             aliases: ['spintel'],                                        categories: ['INTERNET', 'MOBILE'] },
  { name: 'Exetel',              aliases: ['exetel'],                                         categories: ['INTERNET'] },
  // Insurance
  { name: 'NRMA',                aliases: ['nrma'],                                          categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'RACV',                aliases: ['racv'],                                          categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'RACQ',                aliases: ['racq'],                                          categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'Allianz',             aliases: ['allianz'],                                       categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'Suncorp',             aliases: ['suncorp'],                                       categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'QBE',                 aliases: ['qbe'],                                           categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'Budget Direct',       aliases: ['budget direct', 'budgetdirect'],                  categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'Auto & General',      aliases: ['auto & general', 'auto and general'],              categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'Youi',                aliases: ['youi'],                                           categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'GIO',                 aliases: ['gio'],                                            categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'AAMI',                aliases: ['aami'],                                           categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'CGU',                 aliases: ['cgu'],                                            categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'Real Insurance',      aliases: ['real insurance'],                                  categories: ['HOME_INSURANCE', 'CAR_INSURANCE', 'LIFE_INSURANCE'] },
  { name: 'Woolworths Insurance', aliases: ['woolworths insurance'],                            categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'Coles Insurance',     aliases: ['coles insurance'],                                 categories: ['HOME_INSURANCE', 'CAR_INSURANCE'] },
  { name: 'Bupa',                aliases: ['bupa'],                                          categories: ['HEALTH_INSURANCE'] },
  { name: 'Medibank',            aliases: ['medibank'],                                      categories: ['HEALTH_INSURANCE'] },
  { name: 'HCF',                 aliases: ['hcf'],                                           categories: ['HEALTH_INSURANCE'] },
  { name: 'NIB',                 aliases: ['nib'],                                           categories: ['HEALTH_INSURANCE'] },
  { name: 'Australian Unity',    aliases: ['australian unity'],                                categories: ['HEALTH_INSURANCE'] },
  { name: 'CBHS',                aliases: ['cbhs'],                                           categories: ['HEALTH_INSURANCE'] },
  { name: 'Peoplecare',          aliases: ['peoplecare'],                                      categories: ['HEALTH_INSURANCE'] },
  { name: 'Teachers Health',     aliases: ['teachers health'],                                  categories: ['HEALTH_INSURANCE'] },
  { name: 'Defence Health',      aliases: ['defence health'],                                   categories: ['HEALTH_INSURANCE'] },
  { name: 'AHM',                 aliases: ['ahm'],                                             categories: ['HEALTH_INSURANCE'] },
  { name: 'Frank Health',        aliases: ['frank health'],                                     categories: ['HEALTH_INSURANCE'] },
  { name: 'GMHBA',               aliases: ['gmhba'],                                           categories: ['HEALTH_INSURANCE'] },
  { name: 'Westfund',            aliases: ['westfund'],                                         categories: ['HEALTH_INSURANCE'] },
  { name: 'iSelect',             aliases: ['iselect'],                                          categories: ['HEALTH_INSURANCE', 'HOME_INSURANCE', 'CAR_INSURANCE'] },
  // Water
  { name: 'Sydney Water',        aliases: ['sydney water'],                                  categories: ['WATER'] },
  { name: 'Yarra Valley Water',  aliases: ['yarra valley water', 'yarra valley'],            categories: ['WATER'] },
  { name: 'SA Water',            aliases: ['sa water'],                                      categories: ['WATER'] },
  { name: 'Unity Water',         aliases: ['unity water', 'unitywater'],                     categories: ['WATER'] },
  { name: 'Hunter Water',        aliases: ['hunter water'],                                  categories: ['WATER'] },
  // Streaming/subs
  { name: 'Netflix',             aliases: ['netflix'],                                       categories: ['STREAMING'] },
  { name: 'Stan',                aliases: ['stan'],                                          categories: ['STREAMING'] },
  { name: 'Spotify',             aliases: ['spotify'],                                       categories: ['STREAMING'] },
  { name: 'Disney+',             aliases: ['disney+', 'disney plus'],                        categories: ['STREAMING'] },
  { name: 'Amazon',              aliases: ['amazon'],                                        categories: ['STREAMING'] },
  { name: 'YouTube',             aliases: ['youtube premium', 'youtube music'],               categories: ['STREAMING'] },
  { name: 'Apple',               aliases: ['apple tv+', 'apple music', 'apple one'],          categories: ['STREAMING'] },
  { name: 'Paramount+',          aliases: ['paramount+', 'paramount plus'],                    categories: ['STREAMING'] },
  { name: 'Binge',               aliases: ['binge'],                                          categories: ['STREAMING'] },
  { name: 'Kayo',                aliases: ['kayo'],                                           categories: ['STREAMING'] },
  // Roadside assist
  { name: 'NRMA',                aliases: ['nrma roadside', 'nrma motoring'],                  categories: ['ROADSIDE_ASSIST'] },
  { name: 'RACV',                aliases: ['racv roadside', 'racv membership'],                 categories: ['ROADSIDE_ASSIST'] },
  { name: 'RACQ',                aliases: ['racq roadside', 'racq membership'],                 categories: ['ROADSIDE_ASSIST'] },
  { name: 'RAA',                 aliases: ['raa'],                                             categories: ['ROADSIDE_ASSIST'] },
  { name: 'RAC',                 aliases: ['rac'],                                             categories: ['ROADSIDE_ASSIST'] },
  { name: 'RACT',                aliases: ['ract'],                                            categories: ['ROADSIDE_ASSIST'] },
  { name: 'AANT',                aliases: ['aant'],                                            categories: ['ROADSIDE_ASSIST'] },
  // Toll
  { name: 'Linkt',               aliases: ['linkt', 'transurban'],                             categories: ['TOLL_ACCOUNT'] },
  { name: 'E-Toll',              aliases: ['e-toll', 'etoll'],                                  categories: ['TOLL_ACCOUNT'] },
  { name: 'Roam',                aliases: ['roam express'],                                     categories: ['TOLL_ACCOUNT'] },
  // Gyms
  { name: 'Fitness First',       aliases: ['fitness first'],                                    categories: ['GYM'] },
  { name: 'Anytime Fitness',     aliases: ['anytime fitness'],                                   categories: ['GYM'] },
  { name: 'Goodlife',            aliases: ['goodlife'],                                          categories: ['GYM'] },
  { name: 'F45',                 aliases: ['f45'],                                               categories: ['GYM'] },
  // Banks
  { name: 'CommBank',            aliases: ['commonwealth bank', 'commbank', 'cba'],              categories: ['BANK_FEES'] },
  { name: 'Westpac',             aliases: ['westpac'],                                           categories: ['BANK_FEES'] },
  { name: 'ANZ',                 aliases: ['anz'],                                               categories: ['BANK_FEES'] },
  { name: 'NAB',                 aliases: ['nab', 'national australia bank'],                    categories: ['BANK_FEES'] },
  { name: 'ING',                 aliases: ['ing'],                                               categories: ['BANK_FEES'] },
  { name: 'Macquarie',           aliases: ['macquarie bank'],                                    categories: ['BANK_FEES'] },
  // Software
  { name: 'Microsoft',           aliases: ['microsoft 365', 'microsoft office'],                 categories: ['SOFTWARE'] },
  { name: 'Adobe',               aliases: ['adobe creative', 'adobe'],                           categories: ['SOFTWARE'] },
  { name: 'Google',              aliases: ['google one', 'google workspace'],                    categories: ['SOFTWARE'] },
  // Transport
  { name: 'Opal',                aliases: ['opal card', 'opal'],                                 categories: ['PUBLIC_TRANSPORT'] },
  { name: 'Myki',                aliases: ['myki'],                                              categories: ['PUBLIC_TRANSPORT'] },
  { name: 'Go Card',             aliases: ['go card', 'gocard'],                                 categories: ['PUBLIC_TRANSPORT'] },
];

function detectProvider(text: string): { provider: string; categories: ServiceCategory[] } | null {
  const lower = text.toLowerCase();
  // Search the first portion of text where company names typically appear
  const searchArea = lower.slice(0, 3000);

  for (const p of KNOWN_PROVIDERS) {
    if (p.aliases.some(a => {
      // Use word-boundary matching to avoid "stan" matching "understand", "instance", etc.
      const re = new RegExp(`(?:^|[\\s.,;:!?()\\[\\]/"'—–-])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s.,;:!?()\\[\\]/"'—–-])`, 'i');
      return re.test(searchArea);
    })) {
      return { provider: p.name, categories: p.categories };
    }
  }
  return null;
}

/** Guess category from document content keywords if provider wasn't matched */
function detectCategory(text: string): ServiceCategory | null {
  const lower = text.toLowerCase();
  const keywords: [ServiceCategory, string[]][] = [
    ['ELECTRICITY', ['electricity', 'kwh', 'kilowatt', 'nmi', 'meter read', 'solar export', 'feed-in']],
    ['GAS',         ['natural gas', 'gas usage', ' mj ', 'megajoule', 'mirn', 'gas supply']],
    ['WATER',       ['water usage', 'water supply', 'sewerage', 'drainage', ' kl ', 'kilolitre']],
    ['INTERNET',    ['broadband', 'nbn', 'internet', 'download speed', 'data plan', 'modem']],
    ['MOBILE',      ['mobile', 'sim', 'handset', 'data allowance', 'roaming', 'mobile plan', 'calls and sms', 'recharge', 'prepaid', 'gb of data']],
    ['HOME_INSURANCE', ['home insurance', 'building insurance', 'home & contents', 'sum insured']],
    ['CAR_INSURANCE',  ['car insurance', 'motor vehicle', 'comprehensive', 'third party', 'vehicle insurance', 'motor insurance', 'windscreen', 'agreed value', 'market value', 'collision', 'registration']],
    ['HEALTH_INSURANCE', ['health insurance', 'hospital cover', 'extras cover', 'health fund', 'private health']],
    ['COUNCIL_RATES', ['council rates', 'rate notice', 'municipal', 'rateable', 'assessment notice']],
    ['STRATA',      ['strata', 'body corporate', 'owners corporation', 'strata levy', 'sinking fund', 'capital works fund']],
    ['RENT',        ['rent', 'rental', 'tenancy', 'lease agreement', 'landlord', 'lessor', 'tenant', 'bond']],
    ['MORTGAGE',    ['mortgage', 'home loan', 'loan repayment', 'principal', 'interest rate', 'offset account', 'loan balance']],
    ['LIFE_INSURANCE', ['life insurance', 'death benefit', 'life cover', 'tpd', 'total permanent disability']],
    ['CONTENTS_INSURANCE', ['contents insurance', 'contents cover', 'personal effects', 'portable items']],
    ['PET_INSURANCE', ['pet insurance', 'vet cover', 'veterinary', 'pet cover']],
    ['TRAVEL_INSURANCE', ['travel insurance', 'travel cover', 'overseas medical', 'trip cancellation']],
    ['VEHICLE_REGISTRATION', ['vehicle registration', 'rego renewal', 'registration renewal', 'ctp', 'green slip', 'compulsory third party']],
    ['ROADSIDE_ASSIST', ['roadside assist', 'roadside help', 'breakdown', 'motoring club', 'emergency assist', 'tow']],
    ['TOLL_ACCOUNT', ['toll', 'e-toll', 'linkt', 'tag account', 'toll road', 'citylink', 'eastlink']],
    ['LANDLINE',    ['landline', 'home phone', 'fixed line', 'home line']],
    ['PUBLIC_TRANSPORT', ['opal', 'myki', 'go card', 'transit', 'public transport', 'transport pass', 'metro']],
    ['STREAMING',   ['streaming', 'subscription', 'netflix', 'disney', 'spotify', 'stan', 'binge', 'kayo']],
    ['SOFTWARE',    ['software', 'license', 'licence', 'saas', 'cloud storage', 'microsoft 365', 'adobe']],
    ['GYM',         ['gym', 'fitness', 'health club', 'membership', 'personal training']],
    ['SUBSCRIPTION_BOX', ['subscription box', 'monthly box', 'delivery box', 'curated box']],
    ['BANK_FEES',   ['bank fee', 'account keeping fee', 'service fee', 'card fee', 'annual fee', 'monthly account fee']],
  ];

  let best: ServiceCategory | null = null;
  let bestCount = 0;
  for (const [cat, words] of keywords) {
    const hits = words.filter(w => lower.includes(w)).length;
    if (hits > bestCount) { best = cat; bestCount = hits; }
  }
  return bestCount >= 1 ? best : null;
}

// ─── Title suggestion ───────────────────────────────────────

function suggestTitle(text: string, types: DocumentType[], provider: string | null): string {
  const typeLabel = types[0] ? { BILL: 'Bill', CONTRACT: 'Contract', PDS: 'PDS', RENEWAL_NOTICE: 'Renewal', CORRESPONDENCE: 'Letter', RECEIPT: 'Receipt', CERTIFICATE: 'Certificate' }[types[0]] : 'Document';

  if (provider) return `${provider} — ${typeLabel}`;

  // Generic: try to find a company-like name in first lines
  const firstLines = text.split('\n').slice(0, 15).join('\n');
  const companyMatch = firstLines.match(/^([A-Z][A-Za-z\s&]{2,30}?)(?:\s{2,}|\n)/m);
  if (companyMatch && companyMatch[1]!.trim().length >= 3) {
    return `${companyMatch[1]!.trim()} — ${typeLabel}`;
  }

  return typeLabel;
}

// ─── Main parse function ────────────────────────────────────

export function parseDocument(text: string): ParseResult {
  const typeScores = detectDocTypes(text);
  const docTypes = typeScores.filter(s => s.confidence >= 0.2).map(s => s.type);
  if (docTypes.length === 0 && typeScores.length > 0) docTypes.push(typeScores[0]!.type);

  const providerInfo = detectProvider(text);
  const detectedProvider = providerInfo?.provider || null;
  // If provider has multiple categories (e.g. Budget Direct → HOME_INSURANCE, CAR_INSURANCE),
  // use keyword detection to pick the best one from the provider's list
  let detectedCategory: ServiceCategory | null = null;
  if (providerInfo) {
    if (providerInfo.categories.length === 1) {
      detectedCategory = providerInfo.categories[0]!;
    } else {
      const keywordCat = detectCategory(text);
      detectedCategory = providerInfo.categories.find(c => c === keywordCat)
        || providerInfo.categories[0]!;
    }
  } else {
    detectedCategory = detectCategory(text);
  }

  const insights = extractInsights(text);
  const highlights = insights.filter(i => i.importance === 'high');
  const docDate = extractDate(text);
  const sugTitle = suggestTitle(text, docTypes, detectedProvider);

  console.log('[Parser] Result:', { types: docTypes, date: docDate, title: sugTitle, provider: detectedProvider, category: detectedCategory, insightsCount: insights.length, highlightsCount: highlights.length });

  return { docTypes, typeScores, suggestedTitle: sugTitle, docDate, insights, highlights, detectedProvider, detectedCategory };
}
