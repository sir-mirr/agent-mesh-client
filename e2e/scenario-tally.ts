/**
 * The total has to count what was asked for, not what came back.
 *
 * The summary line divided by `results.length` -- the number of scenarios that
 * produced a result -- while the work iterated the selected list. Today those
 * agree, and nothing made them. A scenario dropped between the plan and the
 * tally would leave `17/17 contract scenarios`, which reads as a complete pass
 * of a set that is one short.
 *
 * The shape is not hypothetical. A sweep on the platform side named its summary
 * array the same as a variable already in scope, so the rows went to the inner
 * one and the summary read an empty array -- reporting zero of zero while the
 * work had been done. It was caught because the line printed its denominator.
 */
export function tallyMismatch(planned: number, recorded: number): string | null {
  if (planned === recorded) return null;
  return (
    `${recorded} scenario result(s) for ${planned} selected. ` +
    `${planned - recorded} produced no result at all, and dividing by the ones that did ` +
    `would report a complete pass of a smaller set.`
  );
}
