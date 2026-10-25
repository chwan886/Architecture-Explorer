import type { FlowStep, FlowTransition, SourceAnchor } from './types.ts';

/** Current, non-overlapping source positions support narration, not execution order. */
export function hasSourcePositionSupport(
  files: ReadonlyMap<string, string>, anchors: ReadonlyMap<string, SourceAnchor>,
  transition: Pick<FlowTransition, 'basis' | 'anchorIds'>,
  source?: Pick<FlowStep, 'anchorIds'>, target?: Pick<FlowStep, 'anchorIds'>,
): boolean {
  if (transition.basis !== 'source-order' || !source || !target || !transition.anchorIds.length) return false;
  const selected: SourceAnchor[] = [];
  for (const id of transition.anchorIds) {
    const anchor = anchors.get(id);
    if (!anchor || !/^[a-f0-9]{64}$/.test(anchor.expectedFileHash) || files.get(anchor.filePath) !== anchor.expectedFileHash
      || !Number.isInteger(anchor.startLine) || !Number.isInteger(anchor.endLine) || anchor.startLine < 1 || anchor.endLine < anchor.startLine
      || typeof anchor.quote !== 'string' || anchor.quote.split(/\r?\n/).length !== anchor.endLine - anchor.startLine + 1) return false;
    selected.push(anchor);
  }
  return selected.some(before => source.anchorIds.includes(before.id)
    && selected.some(after => target.anchorIds.includes(after.id) && before.filePath === after.filePath && before.endLine < after.startLine));
}
