import type { GrabPipeline } from './grab-pipeline';
import type { CompletionPoller } from './completion';

export type JobHandler = (jobId: string, args?: unknown) => Promise<void>;

export interface JobHandlerDeps {
  grabPipeline: Pick<GrabPipeline, 'searchMissing' | 'rssSync'>;
  completionPoller: Pick<CompletionPoller, 'poll' | 'cleanStalled' | 'cleanSeeded'>;
}

/** `SearchMissing`'s only documented argument — a manual re-run scoped to specific media. */
function mediaIdsArg(args: unknown): number[] | undefined {
  const raw = (args as { mediaIds?: unknown } | undefined)?.mediaIds;
  return Array.isArray(raw) && raw.every((x) => typeof x === 'number') ? (raw as number[]) : undefined;
}

/**
 * One handler per `manifest.jobs[]` entry (`scripts/manifest-template.ts`'s `JOBS`) — the
 * keys here must equal those five names exactly, or core's `job` dispatch finds nothing
 * (`test/jobs-table.test.ts` proves the two lists match). Each handler is a plain async
 * function: a thrown error propagates to `src/plugin.ts`'s `job` request handler, which is
 * already one Promise among many the dispatcher tracks — it turns into an `ERR` reply, never
 * an unhandled rejection, and never blocks a concurrently in-flight job or request.
 */
export function createJobHandlers(deps: JobHandlerDeps): Readonly<Record<string, JobHandler>> {
  return {
    SearchMissing: async (_jobId, args) => {
      await deps.grabPipeline.searchMissing(mediaIdsArg(args));
    },
    RssSync: async () => {
      await deps.grabPipeline.rssSync();
    },
    ImportCompleted: async () => {
      await deps.completionPoller.poll();
    },
    CleanStalled: async () => {
      await deps.completionPoller.cleanStalled();
    },
    CleanSeeded: async () => {
      await deps.completionPoller.cleanSeeded();
    },
  };
}
