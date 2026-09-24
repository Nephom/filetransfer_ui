export type UploadManifestFile = {
  fileId: string;
  sourcePath: string;
  path: string;
  name: string;
  size: number;
  modified: number;
  chunkHashes: string[];
  manifestHash: string;
};

export type UploadSessionFile = {
  fileId: string;
  index: number;
  path: string;
  name: string;
  size: number;
  chunkSize: number;
  manifestHash: string;
  uploadedOffset: number;
  status: string;
};

const encoder = new TextEncoder();
const compareUtf8 = (left: string, right: string) => {
  const a = encoder.encode(left.replace(/\\/g, "/"));
  const b = encoder.encode(right.replace(/\\/g, "/"));
  const common = Math.min(a.length, b.length);
  for (let index = 0; index < common; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
};

export const sortUploadManifest = (files: UploadManifestFile[]) => files
  .map((file, index) => ({ ...file, path: file.path.replace(/\\/g, "/"), sourceOrder: index }))
  .sort((left, right) => compareUtf8(left.path, right.path) || left.sourceOrder - right.sourceOrder)
  .map(({ sourceOrder: _sourceOrder, ...file }) => file);

export const planUploadChildren = (files: UploadManifestFile[], maxFiles = 500) => {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new TypeError("Invalid upload child capacity");
  const sorted = sortUploadManifest(files);
  const children: UploadManifestFile[][] = [];
  let child: UploadManifestFile[] = [];
  for (let index = 0; index < sorted.length;) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].path.normalize("NFC").toLowerCase() === sorted[index].path.normalize("NFC").toLowerCase()) end += 1;
    const collisionGroup = sorted.slice(index, end);
    if (collisionGroup.length > maxFiles) {
      throw new Error(`More than ${maxFiles} selected files target the same destination path: ${sorted[index].path}`);
    }
    if (child.length && child.length + collisionGroup.length > maxFiles) {
      children.push(child);
      child = [];
    }
    child.push(...collisionGroup);
    index = end;
  }
  if (child.length) children.push(child);
  return children;
};

export const buildManifestPages = (
  files: UploadManifestFile[],
  directories: string[],
  pageSize = 50,
) => {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new TypeError("Invalid upload manifest page size");
  const sortedFiles = sortUploadManifest(files);
  const sortedDirectories = [...new Set(directories.map((value) => value.replace(/\\/g, "/")))].sort(compareUtf8);
  const maximumPageBytes = 4 * 1024 * 1024;
  const encodedLength = (fileOffset: number, directoryOffset: number, pageFiles: UploadManifestFile[], pageDirectories: string[]) =>
    new TextEncoder().encode(JSON.stringify({
      fileOffset, directoryOffset,
      files: pageFiles.map(({ fileId, path, name, size, chunkHashes }) => ({ fileId, path, name, size, chunkHashes })),
      directories: pageDirectories,
    })).length;
  const pages: { pageIndex: number; fileOffset: number; directoryOffset: number; files: UploadManifestFile[]; directories: string[] }[] = [];
  let fileOffset = 0, directoryOffset = 0;
  while (fileOffset < sortedFiles.length || directoryOffset < sortedDirectories.length || !pages.length) {
    const pageFiles: UploadManifestFile[] = [], pageDirectories: string[] = [];
    while (fileOffset + pageFiles.length < sortedFiles.length && pageFiles.length < pageSize) {
      const candidate = sortedFiles[fileOffset + pageFiles.length];
      if (encodedLength(fileOffset, directoryOffset, [...pageFiles, candidate], pageDirectories) > maximumPageBytes) {
        if (!pageFiles.length) throw new Error(`Checksum manifest entry is too large: ${candidate.path}. Increase the upload chunk size.`);
        break;
      }
      pageFiles.push(candidate);
    }
    while (directoryOffset + pageDirectories.length < sortedDirectories.length && pageDirectories.length < pageSize) {
      const candidate = sortedDirectories[directoryOffset + pageDirectories.length];
      if (encodedLength(fileOffset, directoryOffset, pageFiles, [...pageDirectories, candidate]) > maximumPageBytes) break;
      pageDirectories.push(candidate);
    }
    if (!pageFiles.length && !pageDirectories.length && (fileOffset < sortedFiles.length || directoryOffset < sortedDirectories.length)) {
      throw new Error("Upload manifest page could not fit within the API metadata limit.");
    }
    pages.push({ pageIndex: pages.length, fileOffset, directoryOffset, files: pageFiles, directories: pageDirectories });
    fileOffset += pageFiles.length;
    directoryOffset += pageDirectories.length;
  }
  return pages;
};

const fileIdentity = (file: { path: string; name: string; size: number; chunkHashes?: string[]; manifestHash?: string }) =>
  `${file.path}\0${file.name}\0${file.size}\0${file.manifestHash || file.chunkHashes?.join(":") || ""}`;

export const rebindUploadManifest = (localFiles: UploadManifestFile[], serverFiles: UploadSessionFile[]) => {
  const available = new Map<string, UploadSessionFile[]>();
  for (const serverFile of serverFiles) {
    const key = fileIdentity(serverFile);
    const matches = available.get(key) || [];
    matches.push(serverFile);
    available.set(key, matches);
  }
  return sortUploadManifest(localFiles).map((localFile) => {
    const matches = available.get(fileIdentity(localFile));
    const serverFile = matches?.shift();
    if (!serverFile) throw new Error(`Upload source changed or is missing: ${localFile.path}`);
    return { ...localFile, fileId: serverFile.fileId };
  });
};
