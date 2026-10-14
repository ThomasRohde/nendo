import type { IDatasource, IGetRowsParams } from 'ag-grid-community';
import type { RecordSnapshot } from './host-types';
import type { WindowQuery } from './record-window';

export interface RecordBlock {
  items: RecordSnapshot[];
  start: number;
  hasMore: boolean;
  changeSequence: number;
  queryToken: string;
  locatedIndex: number | null;
}

export const studioBlockSize = 100;
export const studioCacheBlocks = 5;

/** AG Grid owns the record cache. This adapter retains only its opening block until consumed. */
export function studioDatasource<T>(options: {
  entityId: string;
  query: WindowQuery;
  sequence: number;
  request(payload: Record<string, unknown>): Promise<RecordBlock>;
  current(): boolean;
  row(record: RecordSnapshot): T;
  loaded(end: number, total: number | null): void;
  failed(error: unknown): void;
  anchor?: { recordId: string; index: number };
  located?(index: number, found: boolean): void;
}): IDatasource {
  const query = structuredClone({ entityId: options.entityId, ...options.query });
  let disposed = false;
  let token: string | null = null;
  let opening: Promise<RecordBlock> | null = null;
  let first: RecordBlock | null = null;
  let located = false;
  const current = (): boolean => !disposed && options.current();
  const read = async (start: number, locateRecordId?: string): Promise<RecordBlock> => {
    const page = await options.request({ query, start, limit: studioBlockSize, queryToken: token, locateRecordId });
    if (page.changeSequence !== options.sequence) throw new Error('The file changed. Refresh the table to continue.');
    return page;
  };
  return {
    destroy() { disposed = true; first = null; },
    getRows(params: IGetRowsParams) {
      void (async () => {
        try {
          if (!current()) { params.failCallback(); return; }
          if (token === null) {
            opening ??= read(options.anchor ? Math.floor(options.anchor.index / studioBlockSize) * studioBlockSize : params.startRow,
              options.anchor?.recordId).then(page => { if (current()) { token = page.queryToken; first = page; } return page; });
            const opened = await opening;
            if (!current()) { params.failCallback(); return; }
            if (!located) {
              located = true;
              options.located?.(opened.locatedIndex ?? 0, opened.locatedIndex !== null);
            }
          }
          const page = first?.start === params.startRow ? first : await read(params.startRow);
          if (page === first) first = null;
          if (!current()) { params.failCallback(); return; }
          const end = page.start + page.items.length;
          options.loaded(end, page.hasMore ? null : end);
          params.successCallback(page.items.map(options.row), page.hasMore ? undefined : end);
        } catch (error) {
          // Each live request ends exactly once, including a rejected opening; Retry can reopen it.
          if (token === null) opening = null;
          params.failCallback();
          if (current()) options.failed(error);
        }
      })();
    },
  };
}
