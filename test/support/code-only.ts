/**
 * Strip comments so an assertion cannot be satisfied by prose about the code.
 *
 * A first version of this removed whole comment lines only, and a mutation that
 * deleted a workflow step still passed -- the comment above it named the script.
 * That was fixed. The other half was not: a comment on the *end* of a line
 * survives, so `- run: echo hi  # scripts/set-version.ts` satisfies both a
 * `contains` check and a regex anchored on `run:`. Measured, both true.
 *
 * The platform hit the same shape the same night from the opposite side -- a
 * string holding a comment opener was treated as a comment and hid a hundred
 * lines. Comments and code are told apart by an approximation either way; what
 * matters is which direction the approximation errs.
 *
 * This one errs toward removing too much. For a `contains` assertion that means
 * a false failure, which is loud. Removing too little means a false pass, which
 * is what this exists to stop.
 */
export type CommentStyle = "hash" | "slash";

export function codeOnly(text: string, style: CommentStyle = "hash"): string {
  const marker = style === "hash" ? "#" : "//";
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith(marker) || trimmed.startsWith("*")) return "";
      // A marker that begins a word is a comment here; one inside a token (a
      // URL fragment, a shebang argument) is left alone.
      const at = line.indexOf(` ${marker}`);
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}
