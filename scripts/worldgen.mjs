// Worldgen v3 batch validation runner (npm run test:worldgen).
// Generates CONFIG.validation.batchCount seeds (derived from batchBaseSeed),
// asserts the Part-H contracts per seed, prints a summary table + the pacing
// distribution, and exits non-zero on any failure. See src/test/worldgenRun.ts
// for the assertion definitions.

import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  logLevel: 'silent',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

let exitCode = 0;
try {
  const t0 = Date.now();
  const mod = await server.ssrLoadModule('/src/test/worldgenRun.ts');
  const { reports, pass } = mod.runBatch();
  const totalMs = Date.now() - t0;

  const fmtLeg = (l) => (l === null ? '  ——' : String(Math.round(l)).padStart(4));
  const fmtGaps = (g) => `${g.usable}/${g.total}${g.clayUsable > 0 ? 'c' : '!'}${g.sand > 0 ? 's' : ''}`;

  console.log(
    'seed'.padStart(11) +
      '  intervals (tiles)   ' +
      'gaps/curtain (usable/total, c=clay ok, s=sand)  ' +
      'legs P0→P1→P2→P3→P4 (est s)  result',
  );
  for (const r of reports) {
    const line =
      String(r.seed).padStart(11) +
      '  ' +
      r.intervals.map((v) => String(v).padStart(3)).join(' ') +
      '       ' +
      r.gapsPerCurtain.map(fmtGaps).join(' ').padEnd(28) +
      r.legSeconds.map(fmtLeg).join(' ') +
      '   ' +
      (r.failures.length === 0 ? 'PASS' : 'FAIL');
    console.log(line);
    for (const f of r.failures) console.log('             ✗ ' + f);
  }

  // Pacing distributions. Only the WEST first leg (P0→P1) is gated — the
  // east leg rides the enemy's pre-dug network by design.
  const dist = (legs, label) => {
    const ls = legs.filter((l) => l !== null).sort((a, b) => a - b);
    if (ls.length === 0) return;
    const q = (p) => Math.round(ls[Math.min(ls.length - 1, Math.floor(p * ls.length))]);
    console.log(
      `${label} (${ls.length}): min ${q(0)}s  p25 ${q(0.25)}s  median ${q(0.5)}s  ` +
        `p75 ${q(0.75)}s  max ${Math.round(ls[ls.length - 1])}s`,
    );
  };
  console.log('');
  dist(reports.map((r) => r.legSeconds[0]), 'west first leg P0→P1 (GATED)   ');
  dist(reports.map((r) => r.legSeconds[3]), 'east first leg P4→P3 (network) ');
  dist(reports.flatMap((r) => [r.legSeconds[1], r.legSeconds[2]]), 'middle legs (informational)    ');

  const genMs = reports.reduce((a, r) => a + r.genMs, 0);
  const failed = reports.filter((r) => r.failures.length > 0).length;
  console.log(
    `\n${reports.length} seeds · ${failed} failed · gen ${genMs} ms · total ${totalMs} ms`,
  );
  if (totalMs > 60_000) {
    console.warn('⚠ batch runtime exceeded 60 s — report this rather than reducing the seed count.');
  }
  if (!pass) {
    console.error('FAIL: one or more seeds violated worldgen contracts.');
    exitCode = 1;
  } else {
    console.log('PASS: all seeds satisfy every worldgen v3 contract.');
  }
} finally {
  await server.close();
}
process.exit(exitCode);
