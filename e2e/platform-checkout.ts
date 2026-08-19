/**
 * Which tree does a contract result describe?
 *
 * The runner used to spawn the harness from the platform author's working
 * checkout. That tree says what the person at it is doing right now, not what
 * the product is: over one evening it was two commits behind with two files
 * modified, then clean and one ahead, then two behind again -- and one run
 * measured it mid-mutation and reported ten of eighteen failing on signatures,
 * a defect that existed in no commit.
 *
 * So the default is a checkout this repository owns and aligns to `origin/main`
 * before each run. What it reports is then a commit anyone can fetch.
 *
 * Alignment happens only for that default. Point `AGENT_MESH_E2E_PLATFORM`
 * somewhere and the runner reads it and never writes to it -- checking out over
 * somebody's work is exactly the thing this exists to stop doing.
 */

/** Only a checkout the runner owns may be moved. */
export function mayAlign(override: string | undefined): boolean {
  return override === undefined || override === "";
}

export function missingCheckoutMessage(path: string): string {
  return (
    `no platform checkout at ${path}. This runner keeps its own so a result names a commit ` +
    `anyone can fetch rather than whatever a working tree happened to hold:\n\n` +
    `  git clone https://github.com/sir-mirr/agent-mesh-platform ${path}\n` +
    `  cd ${path} && bun install --frozen-lockfile\n\n` +
    `Or set AGENT_MESH_E2E_PLATFORM to a checkout you want measured; the runner will read it ` +
    `and never write to it.`
  );
}
