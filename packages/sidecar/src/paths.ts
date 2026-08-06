/**
 * A tool call's `file_path` is an absolute filesystem path; the code graph
 * (and everything keyed off it — Q&A context, blast radius) uses paths
 * relative to the repo root. Shared by qa-context.ts and blast-radius.ts so
 * this normalization only exists once.
 */
export function toRepoRelative(repoRoot: string, absOrRelPath: string): string {
  if (absOrRelPath.startsWith(`${repoRoot}/`)) return absOrRelPath.slice(repoRoot.length + 1);
  return absOrRelPath;
}
