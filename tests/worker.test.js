import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../src/index.js";
import { SYSTEM_PROMPTS, DEMOCRATS_HINT } from "../src/prompt.js";
import { STRINGS } from "../public/i18n.js";

function makeEnv({ ai = async () => ({ response: "  TREMENDOUS text!  " }), allowed = true, kv = {} } = {}) {
  const calls = { ai: [], limiter: [], assets: 0, puts: [], stats: [] };
  const store = new Map(Object.entries(kv));
  return {
    calls,
    store,
    MODEL: "@cf/test/model",
    AI: { run: async (model, input) => (calls.ai.push({ model, input }), ai(model, input)) },
    LIMITER: { limit: async (opts) => (calls.limiter.push(opts), { success: allowed }) },
    ASSETS: { fetch: async () => (calls.assets++, new Response("page")) },
    KV: {
      get: async (key) => store.get(key) ?? null,
      put: async (key, value, opts) => (calls.puts.push({ key, value, opts }), store.set(key, value)),
    },
    STATS: { writeDataPoint: (point) => calls.stats.push(point) },
  };
}

const post = (body, headers = {}) =>
  new Request("https://t.test/api/trumpify", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("non-API paths are served from static assets", async () => {
  const env = makeEnv();
  assert.equal(await (await worker.fetch(new Request("https://t.test/"), env)).text(), "page");
  assert.equal(env.calls.ai.length, 0);
});

test("Cyrillic input gets the Russian prompt at a cooler temperature", async (t) => {
  t.mock.method(Math, "random", () => 0.99);
  const env = makeEnv();
  const resp = await worker.fetch(post({ text: "Коллеги, отчёты до пятницы." }), env);
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { post: "TREMENDOUS text!" });
  const [{ model, input }] = env.calls.ai;
  assert.equal(model, "@cf/test/model");
  assert.equal(input.messages[0].content, SYSTEM_PROMPTS.ru);
  assert.match(input.messages[1].content, /same language as the text\.\n\nКоллеги, отчёты до пятницы\.$/);
  assert.equal(input.temperature, 0.8);
  assert.equal(input.max_tokens, 1000);
  assert.equal(input.chat_template_kwargs.enable_thinking, false);
  assert.deepEqual(env.calls.limiter, [{ key: "203.0.113.7" }]);
});

test("non-Cyrillic input gets the English prompt at 0.9", async () => {
  const env = makeEnv();
  await worker.fetch(post({ text: "Liebe Nachbarn, Hoffest am Samstag." }), env);
  const [{ input }] = env.calls.ai;
  assert.equal(input.messages[0].content, SYSTEM_PROMPTS.en);
  assert.equal(input.temperature, 0.9);
});

test("each prompt carries only its own language section and example", () => {
  const { en, ru } = SYSTEM_PROMPTS;
  assert.doesNotMatch(en, /RUSSIAN|Russian section|квартальные отчёты/);
  assert.match(en, /quarterly reports are due/);
  assert.match(ru, /RUSSIAN:/);
  assert.match(ru, /квартальные отчёты/);
  assert.doesNotMatch(ru, /quarterly reports are due/);
  // Everything shared is identical: ru is en plus the Russian parts.
  assert.equal(ru.split("RUSSIAN:")[0], en.split("RULES:")[0]);
});

test("only some requests ask the model to blame the Democrats", async (t) => {
  const random = t.mock.method(Math, "random", () => 0.1);
  const env = makeEnv();
  await worker.fetch(post({ text: "hi" }), env);
  random.mock.mockImplementation(() => 0.9);
  await worker.fetch(post({ text: "hi" }), env);
  const [asked, plain] = env.calls.ai.map((c) => c.input.messages[1].content);
  assert.match(asked, /blame the Radical Left Democrats/);
  assert.doesNotMatch(plain, /Democrats/);
  assert.match(DEMOCRATS_HINT, /«Жуликоватая Хиллари»/);
  // Any mention in the system prompt and the model blames them in every other post, asked or not.
  for (const prompt of Object.values(SYSTEM_PROMPTS)) assert.doesNotMatch(prompt, /Democrat|Демократ/);
});

test("reads the OpenAI chat shape returned by newer models", async () => {
  const env = makeEnv({ ai: async () => ({ choices: [{ message: { content: "Sad!", reasoning_content: "hmm" } }] }) });
  assert.deepEqual(await (await worker.fetch(post({ text: "hi" }), env)).json(), { post: "Sad!" });
});

test("a post cut by the token limit is logged without the text", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const env = makeEnv({
    ai: async () => ({ choices: [{ message: { content: "HUGE" }, finish_reason: "length" }], usage: { completion_tokens: 1000 } }),
  });
  assert.equal((await worker.fetch(post({ text: "secret words" }), env)).status, 200);
  const lines = log.mock.calls.map((c) => c.arguments[0]);
  assert.ok(lines.some((l) => JSON.parse(l).event === "truncated" && JSON.parse(l).tokens === 1000));
  assert.ok(lines.every((l) => !l.includes("secret")));
});

test("preset texts are served from KV, never from the model, and don't count", async (t) => {
  t.mock.method(Math, "random", () => 0.5);
  for (const lang of ["en", "ru"]) {
    const env = makeEnv({ kv: { [`preset:${lang}:chip3:2`]: "Weather. Great weather!" } });
    const resp = await worker.fetch(post({ text: STRINGS[lang].samples.chip3 }), env);
    assert.deepEqual(await resp.json(), { post: "Weather. Great weather!" });
    assert.equal(env.calls.ai.length, 0);
    assert.equal(env.calls.puts.length, 0);
  }
});

test("seed file covers every preset in both languages", () => {
  const keys = new Set(JSON.parse(readFileSync(new URL("../presets.json", import.meta.url))).map((e) => e.key));
  for (const [lang, s] of Object.entries(STRINGS))
    for (const chip of Object.keys(s.samples)) for (let i = 0; i < 5; i++) assert.ok(keys.has(`preset:${lang}:${chip}:${i}`));
});

test("an unseeded preset falls back to the model", async (t) => {
  t.mock.method(console, "log", () => {});
  const env = makeEnv();
  await worker.fetch(post({ text: STRINGS.en.samples.chip1 }), env);
  assert.equal(env.calls.ai.length, 1);
});

test("five generations an hour per IP, then a friendly 429", async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(post({ text: "hi" }), env)).status, 200);
  const resp = await worker.fetch(post({ text: "hi" }), env);
  assert.equal(resp.status, 429);
  assert.deepEqual(await resp.json(), { error: "hourly" });
  assert.equal(env.calls.ai.length, 5);
  assert.equal(env.calls.puts.at(-1).opts.expirationTtl, 3600);
  // Another IP has its own budget.
  assert.equal((await worker.fetch(post({ text: "hi" }, { "CF-Connecting-IP": "198.51.100.1" }), env)).status, 200);
});

test("the owner key skips the hourly cap; a wrong key doesn't", async () => {
  const env = { ...makeEnv(), OWNER_KEY: "s3cret" };
  for (let i = 0; i < 7; i++) assert.equal((await worker.fetch(post({ text: "hi" }, { "X-Owner-Key": "s3cret" }), env)).status, 200);
  assert.equal(env.calls.puts.length, 0);
  for (let i = 0; i < 5; i++) await worker.fetch(post({ text: "hi" }, { "X-Owner-Key": "nope" }), env);
  assert.equal((await worker.fetch(post({ text: "hi" }, { "X-Owner-Key": "nope" }), env)).status, 429);
  // The burst limiter still sees the owner.
  assert.equal(env.calls.limiter.length, 13);
});

test("failed generations don't eat the hourly budget", async (t) => {
  t.mock.method(console, "log", () => {});
  const env = makeEnv({ ai: async () => { throw new Error("3040: capacity"); } });
  await worker.fetch(post({ text: "hi" }), env);
  assert.equal(env.calls.puts.length, 0);
});

test("every API call leaves one anonymous analytics point", async (t) => {
  t.mock.method(Math, "random", () => 0.5);
  const env = makeEnv({
    kv: { "preset:ru:chip2:2": "Отчёты!" },
    ai: async () => ({ choices: [{ message: { content: "HUGE post" }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 120 } }),
  });
  await worker.fetch(post({ text: "Кот уронил секретный стакан." }), env);
  await worker.fetch(post({ text: STRINGS.ru.samples.chip2 }), env);
  await worker.fetch(post({ text: "   " }), env);
  await worker.fetch(new Request("https://t.test/"), env);
  const [gen, preset, empty] = env.calls.stats;
  assert.equal(env.calls.stats.length, 3);
  assert.deepEqual(gen.blobs.slice(0, 2), ["generated", "ru"]);
  assert.deepEqual([gen.doubles[0], gen.doubles[3], gen.doubles[4], gen.doubles[6]], [200, 900, 120, 0]);
  assert.deepEqual(preset.blobs, ["preset", "ru", "", "chip2"]);
  assert.deepEqual([empty.indexes, empty.doubles[0]], [["empty"], 422]);
  assert.ok(JSON.stringify(env.calls.stats).match(/секретный|203\.0\.113\.7/) === null);
});

test("works without the analytics binding", async () => {
  const env = makeEnv();
  delete env.STATS;
  assert.equal((await worker.fetch(post({ text: "hi" }), env)).status, 200);
  assert.equal((await worker.fetch(post({ text: "" }), env)).status, 422);
});

test("rate-limited IPs never reach the model", async () => {
  const env = makeEnv({ allowed: false });
  assert.equal((await worker.fetch(post({ text: "hi" }), env)).status, 429);
  assert.equal(env.calls.ai.length, 0);
});

test("rejects bad input before calling the model", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(post("not json"), env)).status, 400);
  assert.equal((await worker.fetch(post({ text: "   " }), env)).status, 422);
  assert.equal((await worker.fetch(post({ text: 42 }), env)).status, 422);
  assert.equal((await worker.fetch(post({ text: "x".repeat(3001) }), env)).status, 413);
  assert.equal((await worker.fetch(new Request("https://t.test/api/trumpify"), env)).status, 405);
  assert.equal(env.calls.ai.length, 0);
});

test("spent daily quota and other model failures get their own 503s", async (t) => {
  t.mock.method(console, "log", () => {});
  const quota = makeEnv({ ai: async () => { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); } });
  const resp = await worker.fetch(post({ text: "hi" }), quota);
  assert.equal(resp.status, 503);
  assert.deepEqual(await resp.json(), { error: "quota" });
  const overloaded = makeEnv({ ai: async () => { throw new Error("3040: out of capacity"); } });
  assert.deepEqual(await (await worker.fetch(post({ text: "hi" }), overloaded)).json(), { error: "golfing" });
  const empty = makeEnv({ ai: async () => ({ choices: [{ message: { content: "" } }] }) });
  assert.equal((await worker.fetch(post({ text: "hi" }), empty)).status, 503);
});
