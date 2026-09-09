// URL-encodes each path segment individually (leaving the "/" separators
// intact), for building REMOTE file URLs from a path that may contain
// characters needing percent-encoding. Shared across main.tsx and the
// Transfer Queue actions hook, which both build download/content URLs
// from a REMOTE FileItem's path.
export const downloadPath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

// LOCAL roots are atomic: in particular, a UNC server/share is not two folders.
// HOME-relative paths have an empty root. REMOTE paths do not use these helpers.
const localPathParts = (path: string) => {
  const normalized = /^[A-Za-z]:/.test(path) || path.startsWith("\\\\")
    ? path.replace(/\\/g, "/")
    : path;
  const unc = normalized.match(/^\/\/[^/]+\/[^/]+/);
  const drive = normalized.match(/^[A-Za-z]:(?:\/|$)/);
  const root = unc ? unc[0] : drive ? `${normalized.slice(0, 2)}/` : normalized.startsWith("/") ? "/" : "";
  const parts = normalized.slice(unc ? unc[0].length : drive ? drive[0].length : root.length)
    .split("/").filter(Boolean);
  return { root, parts };
};

export const isAbsoluteLocalPath = (path: string) => Boolean(localPathParts(path).root);

export const localBreadcrumbSegments = (path: string): { label: string; target: string }[] => {
  const { root, parts } = localPathParts(path);
  const prefix = root && !root.endsWith("/") ? `${root}/` : root;
  return [
    { label: root || "HOMEDIR/", target: root },
    ...parts.map((label, index) => ({ label, target: `${prefix}${parts.slice(0, index + 1).join("/")}` })),
  ];
};

// Only elevated sessions supply homeAbsolute, permitting Up to leave HOME.
export const localParentPath = (path: string, homeAbsolute = ""): string => {
  const segments = localBreadcrumbSegments(path || homeAbsolute);
  return segments[Math.max(0, segments.length - 2)].target;
};

export const showLocalUp = (path: string, homeAbsolute = ""): boolean =>
  localBreadcrumbSegments(path || homeAbsolute).length > 1;
