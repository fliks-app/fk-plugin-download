import type { Principal } from '../principal';

/** Lands one handler per `manifest.routes[]` entry (`scripts/manifest-template.ts`): the 8
 *  legacy grab/release aliases plus the indexers/download-clients/delay-profiles/queue reads.
 *  Empty on purpose — every route currently 404s (see `src/plugin.ts`). */
export interface PluginHttpRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  principal: Principal;
}

export interface PluginHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (req: PluginHttpRequest) => Promise<PluginHttpResponse>;

/** Keyed by `"<METHOD> <path>"`, exact string match — phase 10 replaces this with real
 *  `:param` matching (`path-to-regexp`, as core's own registry already uses). */
export const ROUTE_HANDLERS: Readonly<Partial<Record<string, RouteHandler>>> = {};
