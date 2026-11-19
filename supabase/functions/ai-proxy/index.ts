/**
 * Supabase Edge Function: AI Proxy
 *
 * Proxies AI requests to the configured provider using server-side API keys.
 * Users don't need their own API key — the key is stored as a Supabase secret.
 *
 * Secrets required (set via `supabase secrets set`):
 *   AI_PROVIDER   — "anthropic" | "openai" | "gemini"
 *   AI_API_KEY    — the provider's API key
 *   AI_MODEL_FAST — model ID for fast/cheap tier  (e.g. "claude-haiku-5-5")
 *   AI_MODEL_SMART — model ID for smart tier       (e.g. "claude-sonnet-5-5")
 *
 * Request body:
 *   { systemPrompt, userMessage, maxTokens, tier?: "fast"|"smart" }
 *
 * Response:
 *   { content, inputTokens, outputTokens, model }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify the user is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse request
    const { systemPrompt, userMessage, maxTokens = 4096, tier = "fast" } = await req.json();

    if (!systemPrompt || !userMessage) {
      return new Response(JSON.stringify({ error: "Missing systemPrompt or userMessage" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Read server-side config from secrets
    const provider = Deno.env.get("AI_PROVIDER") || "gemini";
    const apiKey = Deno.env.get("AI_API_KEY");
    const modelFast = Deno.env.get("AI_MODEL_FAST");
    const modelSmart = Deno.env.get("AI_MODEL_SMART");

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "AI not configured on server" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const modelId = tier === "smart" ? (modelSmart || modelFast!) : (modelFast || modelSmart!);

    // Route to the correct provider
    let result;
    switch (provider) {
      case "anthropic":
        result = await callAnthropic(apiKey, modelId, systemPrompt, userMessage, maxTokens);
        break;
      case "openai":
        result = await callOpenAI(apiKey, modelId, systemPrompt, userMessage, maxTokens);
        break;
      case "gemini":
        result = await callGemini(apiKey, modelId, systemPrompt, userMessage, maxTokens);
        break;
      default:
        return new Response(JSON.stringify({ error: `Unknown provider: ${provider}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("ai-proxy error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ─── Provider implementations ───────────────────────────────

// Keep in sync with src/platform/anthropic-compat.ts (Edge Functions can't import from src).
// Claude 5 models think by default; thinking tokens count against max_tokens and a thinking
// block can come first, so ask for low effort with headroom and read the first text block.
function anthropicBody(model: string, maxTokens: number, system: string, user: string) {
  const body: Record<string, unknown> = {
    model, max_tokens: maxTokens, system,
    messages: [{ role: "user", content: user }],
  };
  if (/^claude-(haiku|sonnet|opus)-5(-|$)/.test(model)) {
    body.max_tokens = maxTokens + 2048;
    body.output_config = { effort: "low" };
  }
  return body;
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

async function callAnthropic(
  apiKey: string, model: string, system: string, user: string, maxTokens: number
) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(anthropicBody(model, maxTokens, system, user)),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    content: firstText(data.content),
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
    model,
  };
}

async function callOpenAI(
  apiKey: string, model: string, system: string, user: string, maxTokens: number
) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || "",
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    model,
  };
}

async function callGemini(
  apiKey: string, model: string, system: string, user: string, maxTokens: number
) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const usage = data.usageMetadata || {};
  return {
    content: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    model,
  };
}
