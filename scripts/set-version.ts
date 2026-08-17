#!/usr/bin/env bun
/**
 * Write the tag being released into the manifest the binary reads.
 *
 * `v0.1.1` shipped a binary answering `0.1.0-dev.0` — a version matching no tag
 * anyone could have installed. The fix for that lived as inline shell inside
 * `release.yml`, which meant **the only way to execute it was to cut a tag**:
 * it sat there written, asserted, and never once run. The next tag would have
 * been its first execution, and a first execution that is wrong is discovered
 * by the person who installed it.
 *
 * So the logic lives here, where `bun test` reaches it on every push. The
 * workflow calls this; it holds no version logic of its own.
 */

/**
 * The tag is the authority, and only a tag is. A ref that is not one -- a
 * branch, a manual dispatch, an empty string -- would otherwise be written into
 * the manifest verbatim and produce a binary claiming to be version `main`.
 * Refusing is the whole point: there is no sensible fallback, because every
 * fallback invents a version nobody can install.
 */
export function versionFromRef(ref: string): string {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(ref);
  if (!match) {
    throw new Error(
      `${JSON.stringify(ref)} is not a release tag. Expected vMAJOR.MINOR.PATCH — ` +
        `anything else names a version no release page carries.`,
    );
  }
  return match[1]!;
}

export async function writeVersion(path: string, version: string): Promise<void> {
  const manifest = await Bun.file(path).json();
  manifest.version = version;
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readVersion(path: string): Promise<string> {
  return (await Bun.file(path).json()).version;
}

if (import.meta.main) {
  const ref = process.env.GITHUB_REF_NAME ?? "";
  const path = process.argv[2] ?? "package.json";
  let version: string;
  try {
    version = versionFromRef(ref);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  }
  await writeVersion(path, version);
  // Read it back rather than trusting the write. The failure this guards is a
  // manifest that parsed, was written, and holds something else.
  const written = await readVersion(path);
  if (written !== version) {
    process.stderr.write(`${path} holds ${JSON.stringify(written)} after writing ${JSON.stringify(version)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${path} version = ${version}\n`);
}
