const DB_NAME = 'GoogleDriveBackupDB';
const DB_VERSION = 1;
const STORE_NAME = 'files';

export function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function saveFileBackup(file, blob, userId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const data = {
      id: file.id,
      userId: userId,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      modifiedTime: file.modifiedTime,
      parents: file.parents || [],
      blob: blob,
      status: file.trashed ? 'trashed' : 'active',
      backedUp: !!blob
    };
    const request = store.put(data);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function saveMultipleFileBackups(backups, userId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(e.target.error);
    
    for (const item of backups) {
      const data = {
        id: item.file.id,
        userId: userId,
        name: item.file.name,
        mimeType: item.file.mimeType,
        size: item.file.size,
        modifiedTime: item.file.modifiedTime,
        parents: item.file.parents || [],
        blob: item.blob,
        status: item.file.trashed ? 'trashed' : 'active',
        backedUp: !!item.blob
      };
      store.put(data);
    }
  });
}

export async function getAllBackupFiles(userId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = (e) => {
      const allFiles = e.target.result || [];
      const userFiles = allFiles.filter(f => f.userId === userId);
      resolve(userFiles);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteBackupFile(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function updateFileStatus(id, status) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const data = getReq.result;
      if (data) {
        data.status = status;
        store.put(data).onsuccess = () => resolve();
      } else {
        resolve();
      }
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}
