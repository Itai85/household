/** Claude 5-generation models (Haiku/Sonnet/Opus 5.x) think by default. */
export function isClaude5(model: string): boolean {
  return /^claude-(haiku|sonnet|opus)-5(-|$)/.test(model);
}

/**
 * Messages API request body. Claude 5 models think by default, and thinking tokens count
 * against max_tokens, so for plain extraction we ask for low effort and leave headroom.
 * Older models get the plain request (they reject `output_config.effort`).
 */
export function anthropicBody(model: string, maxTokens: number, system: string, user: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (isClaude5(model)) {
    body.max_tokens = maxTokens + 2048;
    body.output_config = { effort: 'low' };
  }
  return body;
}

/** First text block of a response; newer models can put a thinking block first. */
export function firstText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}
