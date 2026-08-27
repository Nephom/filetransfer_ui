// The shape of a single file/directory entry, as returned by both the
// LOCAL filesystem commands and the REMOTE (API and SSH) directory
// listing commands. Shared across main.tsx and the feature hooks/
// components (queue, file browser) that need to reference it without
// importing from main.tsx itself.
export type FileItem = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: number;
};
