/**
 * Refuse a scenario set that names two different scenarios the same thing.
 *
 * `E2E-AUTH-KEYSTREAM-002` was used twice in this repository's contributions to
 * the shared set -- once as a stand-in for pending keys, then again for the real
 * stream. The platform side caught it; nothing here could. The tally compares
 * how many scenarios were selected against how many reported, and a duplicate
 * id passes that check perfectly: both entries are selected, both run, both
 * report. 124 in, 124 out, two of them lying about which one they were.
 *
 * The damage is not the count. It is that `--only E2E-AUTH-KEYSTREAM-002` runs
 * two unrelated scenarios, that a red one names an id whose definition the
 * reader then looks up and finds the *other* one, and that the set silently
 * covers one clause less than it claims.
 */
export function duplicateIds(scenarios: ReadonlyArray<{ id: string }>): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) duplicated.add(scenario.id);
    seen.add(scenario.id);
  }
  return [...duplicated].sort();
}

/**
 * The message carries the count of the whole set, for the same reason the empty
 * selection refusal does: "duplicate id" alone leaves the reader unable to tell
 * a two-entry mistake from a set that is duplicated wholesale.
 */
export function duplicateIdMessage(duplicated: readonly string[], total: number): string {
  return (
    `${duplicated.length} scenario id${duplicated.length === 1 ? "" : "s"} used more than once ` +
    `— of ${total} in the set: ${duplicated.join(", ")}. ` +
    `A duplicate passes the tally: both entries are selected, both run, both report.`
  );
}
