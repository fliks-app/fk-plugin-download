/** Lands the torznab/newznab search drivers extracted from `backend/src/modules/indexers/**`
 *  (~1,400 LOC, phase 10.1) — one entry keyed by `Indexer.implementation`. Empty on purpose. */
export interface IndexerDriver {
  search(
    query: string,
    categories: number[],
  ): Promise<
    {
      title: string;
      downloadUrl: string;
      size: number;
      seeders: number;
      leechers: number;
      publishDate: string;
    }[]
  >;
}

export const INDEXER_DRIVERS: Readonly<Record<string, IndexerDriver>> = {};
