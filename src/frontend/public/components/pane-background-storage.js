const DATABASE_NAME = 'filetransfer-ui-pane-background';
const DATABASE_VERSION = 1;
const STORE_NAME = 'backgrounds';
const RECORD_KEY = 'current';

const storageSupported = () => typeof indexedDB !== 'undefined';

const openDatabase = () => new Promise((resolve, reject) => {
    if (!storageSupported()) return resolve(null);
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open background storage.'));
});

export const loadPaneBackground = async () => {
    const database = await openDatabase();
    if (!database) return null;
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY);
        request.onsuccess = () => { database.close(); resolve(request.result || null); };
        request.onerror = () => { database.close(); reject(request.error || new Error('Unable to read background storage.')); };
    });
};

export const savePaneBackground = async (record) => {
    const database = await openDatabase();
    if (!database) return false;
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(record, RECORD_KEY);
        transaction.oncomplete = () => { database.close(); resolve(true); };
        transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Unable to save background storage.')); };
        transaction.onabort = () => { database.close(); reject(transaction.error || new Error('Unable to save background storage.')); };
    });
};

export const deletePaneBackground = async () => {
    const database = await openDatabase();
    if (!database) return false;
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(RECORD_KEY);
        transaction.oncomplete = () => { database.close(); resolve(true); };
        transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Unable to clear background storage.')); };
        transaction.onabort = () => { database.close(); reject(transaction.error || new Error('Unable to clear background storage.')); };
    });
};
