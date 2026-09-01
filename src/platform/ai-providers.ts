/**
 * Multi-provider AI adapter layer.
 *
 * Supports:
 * - Anthropic (Claude) — native format
 * - OpenAI (ChatGPT) — also covers Grok, Mistral, Groq, Together, local models
 * - Google (Gemini) — Google AI Studio format
 *
 * Each adapter translates between our internal format and the provider's API.
 * The prompts stay the same — they're just text.
 */

// ─── Provider types ──────────────────────────────────────────

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openai-compatible';

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  icon: string;
  apiKeyPrefix: string;        // hint for the user (e.g. "sk-ant-...")
  apiKeyPlaceholder: string;
  defaultBaseUrl: string;
  requiresBaseUrl: boolean;    // true for openai-compatible (custom endpoint)
  models: ModelOption[];
  docs: string;                // link to get API key
}

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  tier: 'fast' | 'smart';     // fast = cheap/quick, smart = better quality
  pricing: { input: number; output: number };  // USD per million tokens
}

export interface AiConfig {
  providerId: ProviderId;
  apiKey: string;
  modelId: string;            // specific model or 'auto'
  baseUrl?: string;           // only for openai-compatible
}

export interface AiRequest {
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
}

export interface AiResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

// ─── Provider catalog ────────────────────────────────────────

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    icon: '🟠',
    apiKeyPrefix: 'sk-ant-',
    apiKeyPlaceholder: 'sk-ant-api03-...',
    defaultBaseUrl: 'https://api.anthropic.com',
    requiresBaseUrl: false,
    docs: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fast & cheap (~$0.001/doc)', tier: 'fast', pricing: { input: 0.80, output: 4.00 } },
      { id: 'claude-sonnet-4-20250514', label: 'Sonnet 4', description: 'Smarter (~$0.005/doc)', tier: 'smart', pricing: { input: 3.00, output: 15.00 } },
    ],
  },
  openai: {
    id: 'openai',
    label: 'ChatGPT (OpenAI)',
    icon: '🟢',
    apiKeyPrefix: 'sk-',
    apiKeyPlaceholder: 'sk-proj-...',
    defaultBaseUrl: 'https://api.openai.com',
    requiresBaseUrl: false,
    docs: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', description: 'Fast & cheap (~$0.001/doc)', tier: 'fast', pricing: { input: 0.15, output: 0.60 } },
      { id: 'gpt-4o', label: 'GPT-4o', description: 'Best quality (~$0.005/doc)', tier: 'smart', pricing: { input: 2.50, output: 10.00 } },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini (Google)',
    icon: '🔵',
    apiKeyPrefix: 'AI',
    apiKeyPlaceholder: 'AIzaSy...',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    requiresBaseUrl: false,
    docs: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Fast & cheap', tier: 'fast', pricing: { input: 0.15, output: 0.60 } },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Best quality', tier: 'smart', pricing: { input: 1.25, output: 10.00 } },
    ],
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI Compatible',
    icon: '🔧',
    apiKeyPrefix: '',
    apiKeyPlaceholder: 'your-api-key',
    defaultBaseUrl: 'http://localhost:11434',
    requiresBaseUrl: true,
    docs: '',
    models: [
      { id: 'custom', label: 'Custom Model', description: 'Enter model name in the field', tier: 'fast', pricing: { input: 0, output: 0 } },
    ],
  },
};

// ─── Auto model selection ────────────────────────────────────

export function pickAutoModel(config: AiConfig, isComplex: boolean): string {
  if (config.modelId !== 'auto') return config.modelId;

  const provider = PROVIDERS[config.providerId];
  if (!provider) return config.modelId;

  const tier = isComplex ? 'smart' : 'fast';
  const match = provider.models.find(m => m.tier === tier);
  return match?.id || provider.models[0]?.id || config.modelId;
}

// ─── Cost estimation ─────────────────────────────────────────

export function estimateCost(providerId: ProviderId, modelId: string, inputTokens: number, outputTokens: number): number {
  const provider = PROVIDERS[providerId];
  if (!provider) return 0;

  const model = provider.models.find(m => m.id === modelId);
  if (!model) return (inputTokens * 3 + outputTokens * 15) / 1_000_000; // fallback
  return (inputTokens * model.pricing.input + outputTokens * model.pricing.output) / 1_000_000;
}

// ─── API adapters ────────────────────────────────────────────

/** Call Anthropic (Claude) API */
async function callAnthropic(config: AiConfig, req: AiRequest): Promise<AiResponse> {
  const baseUrl = config.baseUrl || PROVIDERS.anthropic.defaultBaseUrl;

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: config.modelId,
      max_tokens: req.maxTokens,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text;
  if (!content) throw new Error('No content in Anthropic response');

  return {
    content,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
    model: config.modelId,
  };
}

/** Call OpenAI-compatible API (ChatGPT, Grok, Mistral, Groq, local models) */
async function callOpenAI(config: AiConfig, req: AiRequest): Promise<AiResponse> {
  const baseUrl = config.baseUrl || PROVIDERS.openai.defaultBaseUrl;

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.modelId,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content in OpenAI response');

  return {
    content,
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    model: config.modelId,
  };
}

/** Call Google Gemini API */
async function callGemini(config: AiConfig, req: AiRequest): Promise<AiResponse> {
  const baseUrl = config.baseUrl || PROVIDERS.gemini.defaultBaseUrl;

  const response = await fetch(
    `${baseUrl}/v1beta/models/${config.modelId}:generateContent?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: req.systemPrompt }] },
        contents: [{ parts: [{ text: req.userMessage }] }],
        generationConfig: { maxOutputTokens: req.maxTokens },
      }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('No content in Gemini response');

  const usage = data.usageMetadata || {};
  return {
    content,
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    model: config.modelId,
  };
}

// ─── Unified call function ───────────────────────────────────

export async function callAi(config: AiConfig, req: AiRequest): Promise<AiResponse> {
  switch (config.providerId) {
    case 'anthropic':
      return callAnthropic(config, req);
    case 'openai':
      return callOpenAI(config, req);
    case 'gemini':
      return callGemini(config, req);
    case 'openai-compatible':
      return callOpenAI(config, req);  // Same format as OpenAI
    default:
      throw new Error(`Unknown provider: ${config.providerId}`);
  }
}

// ─── Provider detection from API key ─────────────────────────

export function detectProvider(apiKey: string): ProviderId | null {
  if (!apiKey) return null;
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-')) return 'openai';
  if (apiKey.startsWith('AIza')) return 'gemini';
  if (apiKey.startsWith('xai-')) return 'openai-compatible'; // Grok
  if (apiKey.startsWith('gsk_')) return 'openai-compatible'; // Groq
  return null;
}

// ─── Grok / Groq / other presets ─────────────────────────────

export interface CompatiblePreset {
  id: string;
  label: string;
  icon: string;
  baseUrl: string;
  keyPrefix: string;
  keyPlaceholder: string;
  models: ModelOption[];
  docs: string;
}

export const COMPATIBLE_PRESETS: CompatiblePreset[] = [
  {
    id: 'grok',
    label: 'Grok (xAI)',
    icon: '⚡',
    baseUrl: 'https://api.x.ai',
    keyPrefix: 'xai-',
    keyPlaceholder: 'xai-...',
    docs: 'https://console.x.ai',
    models: [
      { id: 'grok-3-mini-fast', label: 'Grok 3 Mini Fast', description: 'Fast & cheap', tier: 'fast', pricing: { input: 0.30, output: 0.50 } },
      { id: 'grok-3', label: 'Grok 3', description: 'Best quality', tier: 'smart', pricing: { input: 3.00, output: 15.00 } },
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    icon: '🚀',
    baseUrl: 'https://api.groq.com/openai',
    keyPrefix: 'gsk_',
    keyPlaceholder: 'gsk_...',
    docs: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', description: 'Fast & free tier', tier: 'fast', pricing: { input: 0.59, output: 0.79 } },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', description: 'Ultra fast', tier: 'fast', pricing: { input: 0.05, output: 0.08 } },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    icon: '🌬️',
    baseUrl: 'https://api.mistral.ai',
    keyPrefix: '',
    keyPlaceholder: 'your-mistral-key',
    docs: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'mistral-small-latest', label: 'Mistral Small', description: 'Fast & cheap', tier: 'fast', pricing: { input: 0.10, output: 0.30 } },
      { id: 'mistral-large-latest', label: 'Mistral Large', description: 'Best quality', tier: 'smart', pricing: { input: 2.00, output: 6.00 } },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    icon: '🦙',
    baseUrl: 'http://localhost:11434',
    keyPrefix: '',
    keyPlaceholder: 'ollama (no key needed)',
    docs: 'https://ollama.ai',
    models: [
      { id: 'llama3.2', label: 'Llama 3.2', description: 'Local, free', tier: 'fast', pricing: { input: 0, output: 0 } },
      { id: 'mistral', label: 'Mistral', description: 'Local, free', tier: 'fast', pricing: { input: 0, output: 0 } },
    ],
  },
];
