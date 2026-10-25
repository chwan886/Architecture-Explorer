import Ajv from 'ajv';
import schema from '../content-pack.schema.json';
import definitionsSchema from '../../semantic-model/definitions.schema.json';
import type { SemanticControl, SemanticText } from '../../semantic-model/src/types.ts';

/** Data-only presentation adapters. They cannot define source selectors, quotes,
 * code relationships, runtime evidence, or review decisions. */
export interface ContentStepAdapter {
  sourceStepId: string;
  text?: Partial<SemanticText>;
  controls?: Array<Omit<SemanticControl, 'anchorIds'> & { anchorIds?: string[] }>;
}
export interface ContentGroupAdapter { id: string; stepIds: string[]; text?: Partial<SemanticText> }
export interface ContentFlowAdapter {
  sourceFlowId: string; title?: string; description?: string;
  steps?: ContentStepAdapter[]; groups?: ContentGroupAdapter[];
}
export interface SemanticContentPack {
  schemaVersion: '1.0.0'; projectId?: string; flows: ContentFlowAdapter[];
}

const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(definitionsSchema);
const check = ajv.compile<SemanticContentPack>(schema);
export function validateContentPack(value: unknown): asserts value is SemanticContentPack {
  if (!check(value)) throw new Error(`Content pack does not match schema: ${ajv.errorsText(check.errors?.slice(0, 4))}`);
  const unique = (ids: string[], label: string) => {
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate content pack ${label}`);
  };
  unique(value.flows.map(flow => flow.sourceFlowId), 'flow');
  for (const flow of value.flows) {
    unique((flow.steps ?? []).map(step => step.sourceStepId), 'step');
    unique((flow.groups ?? []).map(group => group.id), 'group');
  }
}
