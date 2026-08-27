// URL-encodes each path segment individually (leaving the "/" separators
// intact), for building REMOTE file URLs from a path that may contain
// characters needing percent-encoding. Shared across main.tsx and the
// Transfer Queue actions hook, which both build download/content URLs
// from a REMOTE FileItem's path.
export const downloadPath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");
