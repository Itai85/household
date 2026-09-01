/**
 * Text preprocessor — strips boilerplate from OCR text before sending to AI.
 * Saves tokens by removing T&C, marketing, payment methods, privacy notices,
 * and other noise that doesn't contain useful billing/contract data.
 */

/** Sections to strip entirely — these rarely contain useful data */
const BOILERPLATE_HEADERS = [
  /terms\s*(?:and|&)\s*conditions/i,
  /privacy\s*(?:policy|notice|statement|collection)/i,
  /how\s*to\s*pay/i,
  /ways?\s*to\s*pay/i,
  /payment\s*(?:options|methods?|ways)/i,
  /need\s*help\s*(?:paying|with\s*your\s*bill)/i,
  /having\s*trouble\s*paying/i,
  /financial\s*(?:hardship|difficulty|assistance)/i,
  /(?:energy|power)\s*saving\s*tips/i,
  /important\s*information\s*about\s*your\s*privacy/i,
  /we\s*collect\s*your\s*(?:personal\s*)?information/i,
  /dispute\s*resolution/i,
  /complaints?\s*(?:process|procedure|handling)/i,
  /(?:external|independent)\s*dispute/i,
  /ombudsman/i,
  /contact\s*us\s*if\s*you\s*(?:need|have|want)/i,
  /visit\s*(?:us\s*at|our\s*website)/i,
  /follow\s*us\s*on/i,
  /download\s*(?:our|the)\s*app/i,
  /important\s*safety/i,
  /gas\s*(?:leak|emergency|smell)/i,
  /if\s*you\s*smell\s*gas/i,
  /call\s*(?:000|triple\s*zero)/i,
  /interpreter\s*service/i,
  /national\s*relay\s*service/i,
  /translating\s*and\s*interpreting/i,
];

/** Lines to drop individually — marketing, filler, repetitive */
const NOISE_LINES = [
  /^\s*page\s*\d+\s*(?:of\s*\d+)?\s*$/i,
  /^\s*continued\s*(?:on\s*)?(?:next|over)\s*(?:page)?\s*$/i,
  /^\s*(?:www\.|https?:\/\/)/i,
  /^\s*(?:ABN|ACN)\s*[\d\s]+\s*$/i,
  /^\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{0,4}\s*$/,  // phone numbers by themselves
  /^\s*[A-Z\s]{2,6}\s*$/,  // short all-caps lines (e.g. "NSW", "VIC")
  /^\s*[-–—=_*]{3,}\s*$/,  // horizontal rules
  /^\s*$/,  // empty lines (will be removed anyway)
];

/** Max characters to send to AI — beyond this we're wasting tokens */
const MAX_CHARS = 12000;

/** Rough estimate: ~4 chars per token for English text */
const CHARS_PER_TOKEN = 4;

export interface PreprocessResult {
  /** Cleaned text ready for AI */
  cleanedText: string;
  /** Original text length */
  originalLength: number;
  /** Cleaned text length */
  cleanedLength: number;
  /** Estimated tokens saved */
  tokensSaved: number;
  /** Sections that were stripped */
  strippedSections: string[];
}

/**
 * Pre-process OCR text to remove boilerplate before sending to AI.
 * This typically saves 30-60% of tokens on utility bills.
 */
export function preprocessText(raw: string): PreprocessResult {
  const originalLength = raw.length;
  const strippedSections: string[] = [];

  // Split into lines
  let lines = raw.split('\n');

  // ── Phase 1: Strip entire boilerplate sections ──
  // When we hit a boilerplate header, skip lines until we hit the next
  // section header (all-caps line or another known header)
  const cleanedLines: string[] = [];
  let skipping = false;
  let skipReason = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Check if this line starts a boilerplate section
    const isBoilerplateHeader = BOILERPLATE_HEADERS.some(re => re.test(trimmed));
    if (isBoilerplateHeader && trimmed.length > 5) {
      skipping = true;
      skipReason = trimmed.slice(0, 40);
      strippedSections.push(skipReason);
      continue;
    }

    // If we're skipping, look for section exit signals
    if (skipping) {
      // Exit if we hit a line that looks like a new section header
      // (all-caps, starts with a number, or contains dollar amounts)
      const isNewSection = /^[A-Z][A-Z\s&]{3,30}$/.test(trimmed)
        || /^\d+[\.\)]\s/.test(trimmed)
        || /\$\s*[\d,]+\.\d{2}/.test(trimmed)
        || /^(?:account|customer|policy|period|total|balance|premium|your\s)/i.test(trimmed);

      if (isNewSection) {
        skipping = false;
      } else {
        continue;  // Still in boilerplate, skip
      }
    }

    // Check individual noise lines
    if (NOISE_LINES.some(re => re.test(trimmed))) continue;

    cleanedLines.push(line);
  }

  // ── Phase 2: Collapse excessive whitespace ──
  let text = cleanedLines.join('\n');
  // Collapse 3+ consecutive blank lines to 1
  text = text.replace(/\n{3,}/g, '\n\n');
  // Collapse runs of spaces (but preserve table alignment with 2+ spaces)
  text = text.replace(/[ \t]{4,}/g, '   ');

  // ── Phase 3: Truncate if still too long ──
  if (text.length > MAX_CHARS) {
    // Keep the beginning (header/summary area) and end (totals/signatures)
    const headSize = Math.floor(MAX_CHARS * 0.7);
    const tailSize = MAX_CHARS - headSize - 50;
    text = text.slice(0, headSize) + '\n\n[... middle section trimmed ...]\n\n' + text.slice(-tailSize);
  }

  const cleanedLength = text.length;
  const tokensSaved = Math.round((originalLength - cleanedLength) / CHARS_PER_TOKEN);

  return {
    cleanedText: text.trim(),
    originalLength,
    cleanedLength,
    tokensSaved,
    strippedSections,
  };
}

/** Estimate token count for a string */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
