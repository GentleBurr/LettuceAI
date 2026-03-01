/**
 * Compare all locale files against en.ts to find missing translation keys.
 *
 * Usage: npx tsx scripts/check-translations.ts
 */

import { localeRegistry } from "../src/core/i18n/locales/index";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

const enKeys = new Set(flattenKeys(localeRegistry.en.messages));

console.log(`\n📋 English (en.ts): ${enKeys.size} keys\n`);
console.log("─".repeat(60));

let totalMissing = 0;
let totalExtra = 0;

for (const [locale, { messages, metadata }] of Object.entries(localeRegistry)) {
  if (locale === "en") continue;

  const localeKeys = new Set(flattenKeys(messages as Record<string, unknown>));

  const missing = [...enKeys].filter((k) => !localeKeys.has(k));
  const extra = [...localeKeys].filter((k) => !enKeys.has(k));

  const pct = Math.round(((enKeys.size - missing.length) / enKeys.size) * 100);

  console.log(
    `\n${metadata.label} (${locale}) — ${pct}% complete (${enKeys.size - missing.length}/${enKeys.size})`,
  );

  if (missing.length > 0) {
    totalMissing += missing.length;

    // Group by top-level section
    const grouped: Record<string, string[]> = {};
    for (const key of missing) {
      const section = key.split(".")[0];
      (grouped[section] ??= []).push(key);
    }

    for (const [section, keys] of Object.entries(grouped).sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      console.log(`  ❌ ${section} (${keys.length} missing)`);
      for (const key of keys.slice(0, 5)) {
        console.log(`     - ${key}`);
      }
      if (keys.length > 5) {
        console.log(`     ... and ${keys.length - 5} more`);
      }
    }
  }

  if (extra.length > 0) {
    totalExtra += extra.length;
    console.log(`  ⚠️  ${extra.length} extra keys not in en.ts:`);
    for (const key of extra.slice(0, 3)) {
      console.log(`     + ${key}`);
    }
    if (extra.length > 3) {
      console.log(`     ... and ${extra.length - 3} more`);
    }
  }

  if (missing.length === 0 && extra.length === 0) {
    console.log("  ✅ Fully translated");
  }
}

console.log("\n" + "─".repeat(60));
console.log(
  `\nTotal: ${totalMissing} missing keys, ${totalExtra} extra keys across ${Object.keys(localeRegistry).length - 1} locales\n`,
);
