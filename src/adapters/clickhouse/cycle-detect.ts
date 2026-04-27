/** BFS-style traversal that detects cycles by tracking visited ids.
 *  Throws Error('cycle in <kind> at <id>') when an id is seen twice. */
export async function traverseChain(
  startId: string,
  fetchNext: (id: string) => Promise<string | null>,
  opts: { maxDepth?: number; kind: string }
): Promise<string[]> {
  const { maxDepth = 50, kind } = opts;
  const visited = new Set<string>();
  const chain: string[] = [];
  let current: string | null = startId;
  let depth = 0;
  while (current != null) {
    if (visited.has(current)) {
      throw new Error(`cycle in ${kind} at ${current}`);
    }
    visited.add(current);
    chain.push(current);
    if (++depth > maxDepth) break;
    current = await fetchNext(current);
  }
  return chain;
}

/** BFS traversal of a parent-pointer tree, collecting descendants of `root`. */
export async function collectDescendants(
  rootId: string,
  fetchChildren: (id: string) => Promise<string[]>,
  opts: { kind: string; maxDepth?: number }
): Promise<string[]> {
  const { kind, maxDepth = 50 } = opts;
  const visited = new Set<string>([rootId]);
  const out: string[] = [];
  let frontier: string[] = [rootId];
  let depth = 0;
  while (frontier.length > 0) {
    if (++depth > maxDepth) break;
    const next: string[] = [];
    for (const id of frontier) {
      const children = await fetchChildren(id);
      for (const c of children) {
        if (visited.has(c)) {
          throw new Error(`cycle in ${kind} at ${c}`);
        }
        visited.add(c);
        out.push(c);
        next.push(c);
      }
    }
    frontier = next;
  }
  return out;
}
