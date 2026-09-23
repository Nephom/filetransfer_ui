const LEGACY_DATABASE_NAME = 'filetransfer-ui-pane-background';

export const clearLegacyPaneBackgroundStorage = () => new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(false);
    const request = indexedDB.deleteDatabase(LEGACY_DATABASE_NAME);
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
    request.onblocked = () => resolve(false);
});

const headersFor = (token) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json'
});

const base64ToBlob = (data, mimeType) => {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
};

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Unable to read background image.'));
    reader.readAsDataURL(blob);
});

export const loadPaneBackground = async (token) => {
    const response = await fetch('/api/user/background', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) throw new Error('Unable to load background image.');
    const { background } = await response.json();
    if (!background?.data || !background.mimeType) return null;
    return {
        blob: base64ToBlob(background.data, background.mimeType),
        name: background.name,
        width: background.width,
        height: background.height,
        size: background.size,
        scale: background.scale,
        position: background.position
    };
};

export const savePaneBackground = async (record, token) => {
    const response = await fetch('/api/user/background', {
        method: 'PUT',
        headers: headersFor(token),
        body: JSON.stringify({
            data: await blobToBase64(record.blob),
            mimeType: record.blob.type,
            name: record.name,
            width: record.width,
            height: record.height,
            scale: record.scale,
            position: record.position
        })
    });
    if (!response.ok) throw new Error('Unable to save background image.');
    return true;
};

export const deletePaneBackground = async (token) => {
    const response = await fetch('/api/user/background', {
        method: 'DELETE',
        headers: headersFor(token)
    });
    if (!response.ok) throw new Error('Unable to remove background image.');
    return true;
};
