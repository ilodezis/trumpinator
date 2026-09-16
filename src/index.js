// trumpinator: any text in, a Trump-style post out. Static page from /public, one API route.

import { SYSTEM_PROMPTS, DEMOCRATS_HINT } from "./prompt.js";
import { STRINGS } from "../public/i18n.js";

const MAX_CHARS = 3000;
const DEMOCRATS_SHARE = 0.35;
const MAX_TOKENS = 1000;
const HOURLY_LIMIT = 5;
const PRESET_VARIANTS = 5;

// Preset chip texts map to KV keys: "preset:<lang>:<chip>:<0..4>" holds a ready post, no model call.
const PRESETS = new Map(
  Object.entries(STRINGS).flatMap(([lang, s]) => Object.entries(s.samples).map(([chip, text]) => [text, `preset:${lang}:${chip}`])),
);

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/api/trumpify") return env.ASSETS.fetch(request);
    const stat = { lang: "", preset: "", in: 0, out: 0, promptTokens: 0, tokens: 0, ms: 0, truncated: 0 };
    const resp = await trumpify(request, env, stat);
    // One anonymous point per API call: outcome, language, country, sizes. No IP, no text.
    // The binding is optional: off in wrangler.jsonc until Analytics Engine is enabled on the account.
    if (env.STATS) {
      stat.outcome ??= resp.ok ? "generated" : (await resp.clone().json()).error;
      env.STATS.writeDataPoint({
        indexes: [stat.outcome],
        blobs: [stat.outcome, stat.lang, String(request.cf?.country ?? ""), stat.preset],
        doubles: [resp.status, stat.in, stat.out, stat.promptTokens, stat.tokens, stat.ms, stat.truncated],
      });
    }
    return resp;
  },
};

async function trumpify(request, env, stat) {
  if (request.method !== "POST") return json({ error: "method" }, 405);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await env.LIMITER.limit({ key: ip })).success) return json({ error: "slow_down" }, 429);

  let text;
  try {
    ({ text } = await request.json());
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (typeof text !== "string" || !text.trim()) return json({ error: "empty" }, 422);
  stat.in = text.length;
  if (text.length > MAX_CHARS) return json({ error: "too_long" }, 413);

  const preset = PRESETS.get(text.trim());
  if (preset) {
    const post = await env.KV.get(`${preset}:${Math.floor(Math.random() * PRESET_VARIANTS)}`, { cacheTtl: 3600 });
    if (post) {
      [, stat.lang, stat.preset] = preset.split(":");
      stat.outcome = "preset";
      stat.out = post.length;
      return json({ post });
    }
    // Not seeded: falls through to the model rather than breaking the chip.
    console.log(JSON.stringify({ event: "preset_missing", key: preset }));
  }

  const ru = /\p{Script=Cyrillic}/u.test(text);
  stat.lang = ru ? "ru" : "en";

  // ponytail: KV counter in fixed hourly windows, read-then-write, so parallel requests can slip a few extra posts
  // (LIMITER caps the burst). Counted only on success: KV writes stay under the free daily write cap. Durable Object if it matters.
  const hourKey = `rl:${ip}:${Math.floor(Date.now() / 3600e3)}`;
  const owner = await isOwner(request, env);
  const used = owner ? 0 : Number(await env.KV.get(hourKey)) || 0;
  if (used >= HOURLY_LIMIT) return json({ error: "hourly" }, 429);

  // Roughly one post in three blames the Democrats. The worker flips the coin: asked for "sometimes", a model can't count.
  const democrats = Math.random() < DEMOCRATS_SHARE ? DEMOCRATS_HINT : "";

  let result;
  const t0 = Date.now();
  try {
    result = await env.AI.run(env.MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPTS[stat.lang] },
        // The language reminder sits next to the text: in the system prompt alone the model follows its examples.
        { role: "user", content: `Rewrite this text as the post. Write it in the same language as the text.${democrats}\n\n${text}` },
      ],
      max_tokens: MAX_TOKENS,
      // Hotter Russian breaks case endings.
      temperature: ru ? 0.8 : 0.9,
      // Thinking would spend the token budget and return an empty post.
      chat_template_kwargs: { enable_thinking: false },
    });
  } catch (err) {
    const message = String(err?.message);
    console.log(JSON.stringify({ event: "ai_failed", message: message.slice(0, 200) }));
    // 4006: the free daily neuron allocation is spent. Anything else (overload, etc.) is temporary.
    return json({ error: /4006|daily free allocation/i.test(message) ? "quota" : "golfing" }, 503);
  } finally {
    stat.ms = Date.now() - t0;
  }

  // Older models answer { response }, newer ones the OpenAI chat shape.
  const choice = result?.choices?.[0];
  const post = String(result?.response ?? choice?.message?.content ?? "").trim();
  stat.out = post.length;
  stat.promptTokens = result?.usage?.prompt_tokens ?? 0;
  stat.tokens = result?.usage?.completion_tokens ?? 0;
  // Metrics only: user text never goes to logs.
  if (choice?.finish_reason === "length") {
    stat.truncated = 1;
    console.log(JSON.stringify({ event: "truncated", in: text.length, out: post.length, ru, tokens: stat.tokens }));
  }
  if (!post) return json({ error: "golfing" }, 503);
  if (!owner) await env.KV.put(hourKey, String(used + 1), { expirationTtl: 3600 });
  console.log(JSON.stringify({ event: "trumpify", in: text.length, out: post.length, ru }));
  return json({ post });
}

// The owner's browser sends the OWNER_KEY secret and skips the hourly cap (the per-minute LIMITER still applies).
// Digests are compared, not the keys: string comparison time says nothing about the secret.
async function isOwner(request, env) {
  const key = request.headers.get("X-Owner-Key");
  if (!env.OWNER_KEY || !key) return false;
  const hash = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].join();
  return (await hash(key)) === (await hash(env.OWNER_KEY));
}

function json(body, status = 200) {
  return Response.json(body, { status });
}
