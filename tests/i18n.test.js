import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STRINGS } from "../public/i18n.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const langs = Object.keys(STRINGS);

test("every language has the same keys and the same sample slots", () => {
  const [base, ...rest] = langs;
  for (const lang of rest) {
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), Object.keys(STRINGS[base]).sort(), lang);
    assert.deepEqual(Object.keys(STRINGS[lang].samples).sort(), Object.keys(STRINGS[base].samples).sort(), lang);
  }
});

test("every key the page asks for exists and is not empty", () => {
  const fromAttrs = [...html.matchAll(/data-i18n(?:-html|-placeholder|-aria)?="([^"]+)"/g)].map((m) => m[1]);
  const fromScript = [...html.matchAll(/\bt\("([^"]+)"\)/g)].map((m) => m[1]);
  const used = new Set([...fromAttrs, ...fromScript, "record", "huge", "weak", "e429", "e413", "e422", "e503"]);
  assert.ok(used.size > 30, "page parsing found too few keys");
  for (const lang of langs) {
    for (const key of used) {
      const value = STRINGS[lang][key];
      assert.ok(typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : value?.length, `${lang}.${key}`);
    }
  }
});

test("each sample chip has a text to paste", () => {
  const chips = [...html.matchAll(/class="chip" data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(chips.length, 4);
  for (const lang of langs) for (const chip of chips) assert.ok(STRINGS[lang].samples[chip], `${lang}.samples.${chip}`);
});

const html404 = readFileSync(new URL("../public/404.html", import.meta.url), "utf8");

test("every key the 404 page asks for exists and is not empty", () => {
  const fromAttrs = [...html404.matchAll(/data-i18n(?:-html|-placeholder|-aria)?="([^"]+)"/g)].map((m) => m[1]);
  const fromScript = [...html404.matchAll(/\bt\("([^"]+)"\)/g)].map((m) => m[1]);
  const used = new Set([...fromAttrs, ...fromScript]);
  assert.ok(used.size >= 10, "404 page parsing found too few keys");
  for (const lang of langs) {
    for (const key of used) {
      const value = STRINGS[lang][key];
      assert.ok(typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : value?.length, `${lang}.${key}`);
    }
  }
});
