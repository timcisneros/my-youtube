interface OffsetPageResult<T> {
  items: T[];
  totalResults: number;
}

const PAGINATION_MAX_PAGE = Math.max(100, Number(process.env.PAGINATION_MAX_PAGE) || 2_500);

async function loadOffsetPage<T>(
  requestedPage: unknown,
  pageSize: number,
  loader: (offset: number, limit: number) => Promise<OffsetPageResult<T>>,
) {
  // Bound OFFSET work from hostile or accidentally enormous page values. At
  // the default page sizes this caps scans at 100k-250k rows while retaining
  // ordinary numbered navigation.
  const parsed = Math.min(
    PAGINATION_MAX_PAGE,
    Math.max(1, parseInt(String(requestedPage || '1'), 10) || 1),
  );
  let page = parsed;
  let result = await loader((page - 1) * pageSize, pageSize);
  const totalPages = Math.min(
    PAGINATION_MAX_PAGE,
    Math.max(1, Math.ceil(result.totalResults / pageSize)),
  );
  if (page > totalPages) {
    page = totalPages;
    result = await loader((page - 1) * pageSize, pageSize);
  }
  return {
    ...result,
    page,
    totalPages,
    nextPage: page < totalPages ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null,
  };
}

export { loadOffsetPage };
export type { OffsetPageResult };
