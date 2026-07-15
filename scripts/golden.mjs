// Golden-seed determinism test. Runs the fixed golden script headlessly and
// compares the final sim-state hash against src/test/golden.json.
//
//   npm run test:golden                  → pass/fail against the stored hash
//   npm run test:golden -- --update-golden → intentionally re-baseline (only
//     when a sim/worldgen change is DELIBERATE; note it in the commit message)
//
// Uses Vite's ssrLoadModule to execute the TypeScript sim in Node — vite is
// already a dev dependency, so this adds nothing.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const GOLDEN_PATH = new URL('../src/test/golden.json', import.meta.url);
const update = process.argv.includes('--update-golden');

// ---------------------------------------------------------------------------
// Guard: no transcendental / nondeterministic Math inside the sim boundary.
// Allowed: sqrt, abs, floor/ceil/round, min/max, sign, imul, trunc, PI (a
// constant). Banned: everything implementation-defined across JS engines,
// plus randomness and wall-clock. Comments are stripped before scanning.
// ---------------------------------------------------------------------------
const SIM_BOUNDARY = ['src/sim', 'src/core', 'src/command.ts', 'src/config.ts'];
const BANNED =
  /\b(?:Math\.(?:sin|cos|tan|atan2?|asin|acos|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log(?:2|10|1p)?|pow|hypot|cbrt|random)|Date\.now|performance\.now)\b/g;

function listFiles(entry) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const full = join(root, entry);
  if (entry.endsWith('.ts')) return [full];
  return readdirSync(full, { recursive: true })
    .filter((f) => String(f).endsWith('.ts'))
    .map((f) => join(full, String(f)));
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const violations = [];
for (const entry of SIM_BOUNDARY) {
  for (const file of listFiles(entry)) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      const hits = line.match(BANNED);
      if (hits) violations.push(`${file}:${i + 1}  ${hits.join(', ')}`);
    });
  }
}
if (violations.length > 0) {
  console.error('FAIL: banned nondeterministic Math inside the sim boundary:');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log(`guard:         clean (${SIM_BOUNDARY.join(', ')})`);

const server = await createServer({
  configFile: false,
  logLevel: 'silent',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

let exitCode = 0;
try {
  const mod = await server.ssrLoadModule('/src/test/goldenRun.ts');
  const res = mod.runGolden();

  console.log(`golden seed:   ${mod.GOLDEN_SEED}`);
  console.log(`ticks:         ${res.ticks}`);
  console.log(`runtime:       ${res.runMs} ms (two runs + hashing)`);
  console.log(`hash:          ${res.hash}`);
  console.log(`repeatOk:      ${res.repeatOk}`);
  console.log(`sensitivityOk: ${res.sensitivityOk}`);
  console.log(`coverage:      ${JSON.stringify(res.coverage)}`);

  const cov = res.coverage;
  const covOk =
    cov.walked && cov.jumped && cov.climbedLadder && cov.dugTiles > 20 &&
    cov.everCrouched && cov.lampSwapped &&
    cov.enteredSap && cov.materialsDug.length >= 2; // Stage-4 additions
  if (!res.repeatOk) {
    console.error('FAIL: two in-process runs disagreed — nondeterminism inside the sim!');
    exitCode = 1;
  } else if (!res.sensitivityOk) {
    console.error('FAIL: tile flip did not change the hash — hash is blind to the world!');
    exitCode = 1;
  } else if (!covOk) {
    console.error('FAIL: script coverage incomplete — golden run is not exercising enough systems.');
    exitCode = 1;
  } else if (update) {
    writeFileSync(
      GOLDEN_PATH,
      JSON.stringify({ seed: mod.GOLDEN_SEED, ticks: res.ticks, hash: res.hash }, null, 2) + '\n',
    );
    console.log('golden.json UPDATED — make sure this change is intentional.');
  } else {
    let golden;
    try {
      golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    } catch {
      console.error('FAIL: src/test/golden.json missing — run with --update-golden to create it.');
      exitCode = 1;
    }
    if (golden) {
      if (golden.hash === res.hash) {
        console.log('PASS: hash matches golden.');
      } else {
        console.error(`FAIL: hash mismatch — golden ${golden.hash}, got ${res.hash}.`);
        console.error('If this change is intentional, re-baseline with --update-golden.');
        exitCode = 1;
      }
    }
  }
} finally {
  await server.close();
}
process.exit(exitCode);
