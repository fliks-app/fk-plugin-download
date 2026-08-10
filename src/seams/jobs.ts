/** Lands one handler per `manifest.jobs[]` entry (`scripts/manifest-template.ts`), dispatched
 *  by `src/plugin.ts`'s `job` handler. Empty on purpose — every job is currently unhandled. */
export type JobHandler = (jobId: string, args?: unknown) => Promise<void>;

export const JOB_HANDLERS: Readonly<Partial<Record<string, JobHandler>>> = {};
