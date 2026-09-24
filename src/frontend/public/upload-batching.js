const encoder = new TextEncoder();
const compareUtf8 = (left, right) => {
    const a = encoder.encode(left.replace(/\\/g, '/'));
    const b = encoder.encode(right.replace(/\\/g, '/'));
    const common = Math.min(a.length, b.length);
    for (let index = 0; index < common; index++) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
};
const normalizeRelativePath = value => {
    const parts = String(value || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
    if (!parts.length || parts.some(part => part === '..' || /[\x00-\x1f]/.test(part))) throw new Error('Invalid upload relative path.');
    return parts.join('/');
};
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const createId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};
const sha256Constants = Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotateRight = (value, count) => (value >>> count) | (value << (32 - count));
const sha256Fallback = bytes => {
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    const hash = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const words = new Uint32Array(64);
    for (let block = 0; block < paddedLength; block += 64) {
        for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(block + index * 4, false);
        for (let index = 16; index < 64; index += 1) {
            const x = words[index - 15], y = words[index - 2];
            const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
            const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
            words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + sum1 + choice + sha256Constants[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sum0 + majority) >>> 0;
            h = g; g = f; f = e; e = (d + temp1) >>> 0;
            d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
    }
    const result = new Uint8Array(32), resultView = new DataView(result.buffer);
    hash.forEach((word, index) => resultView.setUint32(index * 4, word, false));
    return result;
};
const sha256 = async bytes => globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
    : sha256Fallback(bytes);
export const sha256FallbackHex = value => hex(sha256Fallback(new TextEncoder().encode(value)));
const hashManifest = async (size, chunkHashes) => {
    const sizeBytes = encoder.encode(String(size));
    const bytes = new Uint8Array(chunkHashes.length * 32 + sizeBytes.length);
    chunkHashes.forEach((hash, index) => {
        for (let byte = 0; byte < 32; byte += 1) bytes[index * 32 + byte] = Number.parseInt(hash.slice(byte * 2, byte * 2 + 2), 16);
    });
    bytes.set(sizeBytes, chunkHashes.length * 32);
    return hex(await sha256(bytes));
};

export const buildBrowserUploadManifest = async (items, directories, chunkSize, signal) => {
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 * 1024 || chunkSize > 64 * 1024 * 1024) {
        throw new Error('The server returned an unsupported upload chunk size.');
    }
    const files = [];
    let totalSize = 0;
    for (let index = 0; index < items.length; index++) {
        if (signal?.aborted) throw Object.assign(new Error('Upload manifest preparation was cancelled.'), { name: 'AbortError' });
        const { file, relativePath } = items[index];
        if (!(file instanceof Blob)) throw new Error('The selected upload source is unavailable. Re-select the files.');
        const path = normalizeRelativePath(relativePath || file.webkitRelativePath || file.name);
        const name = path.split('/').pop();
        const chunkHashes = [];
        for (let offset = 0; offset < file.size; offset += chunkSize) {
            if (signal?.aborted) throw Object.assign(new Error('Upload manifest preparation was cancelled.'), { name: 'AbortError' });
            const chunk = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
            chunkHashes.push(hex(await sha256(new Uint8Array(chunk))));
        }
        totalSize += file.size;
        if (!Number.isSafeInteger(totalSize)) throw new Error('Selected upload size exceeds the supported range.');
        files.push({
            fileId: createId(), file, path, name, size: file.size,
            modified: Number(file.lastModified) || 0, chunkHashes, sourceIndex: index,
            manifestHash: await hashManifest(file.size, chunkHashes),
        });
    }
    files.sort((left, right) => compareUtf8(left.path, right.path) || left.sourceIndex - right.sourceIndex);
    for (const file of files) delete file.sourceIndex;
    const sortedDirectories = inferBrowserUploadDirectories(files, directories);
    return { files, directories: sortedDirectories, totalSize };
};

export const inferBrowserUploadDirectories = (files, directories = []) => {
    const inferredDirectories = new Set(directories.map(normalizeRelativePath));
    for (const file of files) {
        const relativePath = normalizeRelativePath(file.path || file.relativePath || file.file?.webkitRelativePath || file.file?.name);
        const parts = relativePath.split('/');
        for (let index = 1; index < parts.length; index += 1) inferredDirectories.add(parts.slice(0, index).join('/'));
    }
    return [...inferredDirectories].sort(compareUtf8);
};

export const planBrowserUploadChildren = (files, maxFiles = 500) => {
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new TypeError('Invalid child upload capacity');
    files = files.map((file, index) => ({ file, index }))
        .sort((left, right) => compareUtf8(left.file.path, right.file.path) || left.index - right.index)
        .map(entry => entry.file);
    const children = [];
    let child = [];
    for (let index = 0; index < files.length;) {
        let end = index + 1;
        while (end < files.length && files[end].path.normalize('NFC').toLowerCase() === files[index].path.normalize('NFC').toLowerCase()) end += 1;
        const collisionGroup = files.slice(index, end);
        if (collisionGroup.length > maxFiles) throw new Error(`More than ${maxFiles} files target ${files[index].path}.`);
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

export const buildBrowserManifestPages = (files, directories, pageSize = 50) => {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new TypeError('Invalid upload manifest page size');
    const maximumPageBytes = 4 * 1024 * 1024;
    const encodedLength = (fileOffset, directoryOffset, pageFiles, pageDirectories) => encoder.encode(JSON.stringify({
        fileOffset, directoryOffset,
        files: pageFiles.map(({ fileId, path, name, size, chunkHashes }) => ({ fileId, path, name, size, chunkHashes })),
        directories: pageDirectories,
    })).length;
    const pages = [];
    let fileOffset = 0, directoryOffset = 0;
    while (fileOffset < files.length || directoryOffset < directories.length || !pages.length) {
        const pageFiles = [], pageDirectories = [];
        while (fileOffset + pageFiles.length < files.length && pageFiles.length < pageSize) {
            const candidate = files[fileOffset + pageFiles.length];
            if (encodedLength(fileOffset, directoryOffset, [...pageFiles, candidate], pageDirectories) > maximumPageBytes) {
                if (!pageFiles.length) throw new Error(`Checksum manifest entry is too large: ${candidate.path}. Increase the upload chunk size.`);
                break;
            }
            pageFiles.push(candidate);
        }
        while (directoryOffset + pageDirectories.length < directories.length && pageDirectories.length < pageSize) {
            const candidate = directories[directoryOffset + pageDirectories.length];
            if (encodedLength(fileOffset, directoryOffset, pageFiles, [...pageDirectories, candidate]) > maximumPageBytes) break;
            pageDirectories.push(candidate);
        }
        if (!pageFiles.length && !pageDirectories.length && (fileOffset < files.length || directoryOffset < directories.length)) {
            throw new Error('Upload manifest page could not fit within the API metadata limit.');
        }
        pages.push({ pageIndex: pages.length, fileOffset, directoryOffset, files: pageFiles, directories: pageDirectories });
        fileOffset += pageFiles.length;
        directoryOffset += pageDirectories.length;
    }
    return pages;
};

const identity = file => `${file.path}\0${file.name}\0${file.size}\0${file.manifestHash || file.chunkHashes.join(':')}`;

export const rebindBrowserUploadManifest = (localFiles, serverFiles) => {
    const byIdentity = new Map();
    for (const file of serverFiles) {
        const key = identity(file);
        const matches = byIdentity.get(key) || [];
        matches.push(file);
        byIdentity.set(key, matches);
    }
    return localFiles.map(file => {
        const match = byIdentity.get(identity(file))?.shift();
        if (!match) throw new Error(`The selected source does not match the unfinished upload: ${file.path}`);
        return { ...file, fileId: match.fileId, index: match.index };
    });
};
