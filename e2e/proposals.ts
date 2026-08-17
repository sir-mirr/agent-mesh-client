/**
 * Scenarios this side would like the contract to carry. **Not the contract.**
 *
 * A scenario kept here is this repository's opinion, which is the thing
 * `E2E_SCENARIOS` exists to stop. They live here only long enough to be run
 * against a real mesh and shown to work, because a proposal that has never been
 * executed is a paragraph, and the platform side owns the contract and should
 * be asked with evidence rather than with a wish.
 *
 * The runner reports these separately and never counts them in the shared
 * total. A green proposal proves nothing about cross-repository agreement --
 * only that it is worth proposing. Once one is accepted upstream it must be
 * deleted from here; keeping a local copy of an accepted scenario recreates the
 * two-lists problem in a quieter form.
 */

import type { Scenario } from "@agent-mesh/contracts";

export const PROPOSED_SCENARIOS: readonly Scenario[] = [
  {
    id: "PROP-RESTART-001",
    clause: "§ 10.2",
    why: "A lane re-registers with the key it already holds on every restart. If that knocks an approved key back to pending, every restart needs an operator, and the mesh is unavailable for as long as nobody is looking.",
    steps: [
      { do: "provision", identity: "prop-restart", type: "ai-claude", key: true, expect: { status: 201 } },
      { do: "approve", identity: "prop-restart" },
      { do: "connect", identity: "prop-restart", expect: { error: null } },
      // The restart: the same identity offering the same key again.
      { do: "provision", identity: "prop-restart", type: "ai-claude", reuseKeyOf: "prop-restart", expect: { status: 200 } },
      { do: "connect", identity: "prop-restart", expect: { error: null } },
    ],
  },
  {
    id: "PROP-KEYS-001",
    clause: "§ 10.2",
    why: "The provisioning response's `key` object is not evidence that this caller's key was recorded -- when the public key is held elsewhere the status returned describes the other holder. The read-back is what a lane must believe, so the route has to answer without a signature: a key that is not yet approved cannot sign for itself.",
    steps: [
      { do: "provision", identity: "prop-keys", type: "ai-claude", key: true, expect: { status: 201 } },
      { do: "http", method: "GET", path: "/api/v1/agents/prop-keys/keys", as: "none", expect: { status: 200 } },
    ],
  },
];
