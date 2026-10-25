// Compatibility entry point. Project and acceptance story are explicit.
import { runStoryCli } from './validate-story.ts';

runStoryCli().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
