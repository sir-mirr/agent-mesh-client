#!/usr/bin/env bun
/**
 * Did a range of platform commits touch anything the contract scenarios reach?
 *
 * `18/18` twice means two different things: the second run asked the same
 * questions of changed code, or it asked them of code nothing changed in. Both
 * print the same number, and counting them the same way overstates coverage.
 *
 * Until now that call was made by reading commit titles, which is a prediction
 * dressed as a measurement. This reads the diff.
 *
 * The surface is where the runner actually sends bytes:
 *   - the Hub, for `/api/v1/agents`, `/api/v1/mailbox/*`, `/api/v1/capabilities`,
 *     `/api/v1/audit/events` and the WebSocket RPC
 *   - the HTTP service, for the admin session the ready file hands out and the
 *     admin routes three scenarios call
 * Its browser UI is not on that path: no scenario loads a screen.
 */
const SURFACE = [/^packages\/hub\/src\//, /^packages\/http\/src\//];
const NOT_SURFACE = [/^packages\/http\/src\/ui\//];

export function touchesSurface(paths: readonly string[]): string[] {
  return paths.filter(
    (path) => SURFACE.some((re) => re.test(path)) && !NOT_SURFACE.some((re) => re.test(path)),
  );
}

if (import.meta.main) {
  const [checkout, from, to] = process.argv.slice(2);
  if (!checkout || !from || !to) {
    process.stderr.write("usage: contract-surface.ts <checkout> <from> <to>\n");
    process.exit(2);
  }
  const diff = Bun.spawnSync(["git", "-C", checkout, "diff", "--name-only", `${from}..${to}`]);
  if (diff.exitCode !== 0) {
    process.stderr.write(`git diff failed: ${diff.stderr.toString().trim()}\n`);
    process.exit(2);
  }
  const paths = diff.stdout.toString().split("\n").filter(Boolean);
  const hits = touchesSurface(paths);
  process.stdout.write(`changed ${paths.length} · surface ${hits.length}\n`);
  for (const hit of hits) process.stdout.write(`  ${hit}\n`);
}
