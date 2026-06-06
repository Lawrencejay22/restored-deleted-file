import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { LogOut, Trash2, RefreshCw, RotateCcw, FileCheck, Clock, AlertTriangle, Settings, LayoutGrid, List, ChevronDown, ChevronUp, ChevronRight } from 'lucide-react';
import FileItem from './FileItem';
import { saveFileBackup, getAllBackupFiles, deleteBackupFile, updateFileStatus, saveMultipleFileBackups } from '../services/db';

function Dashboard({ userProfile, accessToken, onLogout }) {
  const userId = userProfile?.id || userProfile?.email || 'default_user';
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [syncProgress, setSyncProgress] = useState({ current: 0, total: 0 });
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState(null);
  const [showActiveFiles, setShowActiveFiles] = useState(false);
  const [activeFiles, setActiveFiles] = useState([]);
  const [layoutView, setLayoutView] = useState('grid');
  const [sortBy, setSortBy] = useState('modifiedTime');
  const [sortOrder, setSortOrder] = useState('desc');
  const [groupBy, setGroupBy] = useState('none');
  const [expandedGroups, setExpandedGroups] = useState({});

  const syncRef = useRef(0);
  const abortControllerRef = useRef(null);

  const loadCachedFiles = useCallback(async () => {
    try {
      const cached = await getAllBackupFiles(userId);
      const deletedList = cached
        .filter(f => f.status === 'trashed' || f.status === 'permanently_deleted')
        .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
      const activeList = cached
        .filter(f => f.status === 'active')
        .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
      setFiles(deletedList);
      setActiveFiles(activeList);
    } catch (e) {
      console.error('Failed to load initial cache:', e);
    }
  }, [userId]);

  const syncGoogleDrive = useCallback(async () => {
    setSyncing(true);
    setError(null);
    setSyncStatus('Connecting to Google Drive...');
    setSyncProgress({ current: 0, total: 0 });

    const currentSyncId = ++syncRef.current;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    try {
      let googleFiles = [];
      let nextPageToken = null;

      // 1. Fetch metadata of ALL files (active + trashed)
      setSyncStatus('Fetching file list from Google Drive...');
      do {
        if (currentSyncId !== syncRef.current) return;

        const query = "mimeType != 'application/vnd.google-apps.folder'";
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,parents,trashed)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000${nextPageToken ? `&pageToken=${nextPageToken}` : ''}`;

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Google API error (${response.status}): ${errText || response.statusText}`);
        }

        const result = await response.json();
        googleFiles.push(...(result.files || []));
        nextPageToken = result.nextPageToken;
        setSyncStatus(`Fetched ${googleFiles.length} files...`);
      } while (nextPageToken);

      if (currentSyncId !== syncRef.current) return;

      const googleFileIds = new Set(googleFiles.map(f => f.id));

      // 2. Load local backups and detect permanently deleted files
      const localBackups = await getAllBackupFiles(userId);
      if (currentSyncId !== syncRef.current) return;
      const localBackupsMap = new Map(localBackups.map(f => [f.id, f]));

      // Mark files that existed in our backup but NOT in Google Drive as permanently deleted
      for (const localFile of localBackups) {
        if (currentSyncId !== syncRef.current) return;
        if (!googleFileIds.has(localFile.id)) {
          if (localFile.status !== 'permanently_deleted') {
            console.log(`[Detect] File "${localFile.name}" (${localFile.id}) is permanently deleted - no longer in Google Drive`);
            await updateFileStatus(localFile.id, 'permanently_deleted');
            localFile.status = 'permanently_deleted';
            localBackupsMap.set(localFile.id, localFile);
          }
        }
      }

      // 3. Save metadata of all Google Drive files (fast bulk write — no downloads yet)
      const backupsToSave = [];
      for (const file of googleFiles) {
        if (currentSyncId !== syncRef.current) return;
        const existing = localBackupsMap.get(file.id);
        const status = file.trashed ? 'trashed' : 'active';

        // Save if file is new, or if metadata/status changed
        if (!existing || existing.modifiedTime !== file.modifiedTime || existing.status !== status) {
          const existingBlob = existing ? existing.blob : null;
          const isBackedUp = existing ? existing.backedUp : false;

          backupsToSave.push({
            file: {
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              size: file.size,
              modifiedTime: file.modifiedTime,
              parents: file.parents || [],
              trashed: file.trashed
            },
            blob: existingBlob
          });

          localBackupsMap.set(file.id, {
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            modifiedTime: file.modifiedTime,
            parents: file.parents || [],
            status: status,
            backedUp: isBackedUp,
            blob: existingBlob
          });
        }
      }

      if (backupsToSave.length > 0) {
        setSyncStatus(`Saving metadata for ${backupsToSave.length} files...`);
        await saveMultipleFileBackups(backupsToSave, userId);
      }

      if (currentSyncId !== syncRef.current) return;

      // Show metadata list instantly
      const initialBackups = await getAllBackupFiles(userId);
      if (currentSyncId !== syncRef.current) return;
      const initialDeleted = initialBackups
        .filter(f => f.status === 'trashed' || f.status === 'permanently_deleted')
        .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
      const initialActive = initialBackups
        .filter(f => f.status === 'active')
        .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
      setFiles(initialDeleted);
      setActiveFiles(initialActive);

      // 4. Background download: Download actual file content blobs
      const sizeLimit = 25 * 1024 * 1024; // 25MB

      let filesToDownload = googleFiles.filter(file => {
        const existing = localBackupsMap.get(file.id);
        const fileSize = parseInt(file.size || '0');
        // Skip files over size limit, folders (shouldn't be here), and already-backed-up unchanged files
        if (fileSize > sizeLimit) return false;
        if (!existing) return true; // New file, needs backup
        if (!existing.backedUp) return true; // Not backed up yet
        if (existing.modifiedTime !== file.modifiedTime) return true; // Modified since last backup
        return false;
      });

      // Prioritize trashed files, then limit active files
      const trashedToDownload = filesToDownload.filter(f => f.trashed);
      const activeToDownload = filesToDownload.filter(f => !f.trashed);
      activeToDownload.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
      const limitedActive = activeToDownload.slice(0, 200);
      filesToDownload = [...trashedToDownload, ...limitedActive];

      const totalToDownload = filesToDownload.length;
      setSyncProgress({ current: 0, total: totalToDownload });

      if (totalToDownload === 0) {
        setSyncStatus('All files are already synced!');
        setTimeout(() => setSyncStatus(''), 2000);
        return;
      }

      let downloadCount = 0;
      let failedCount = 0;

      // Concurrent download queue (3 parallel workers)
      const downloadWorker = async () => {
        while (filesToDownload.length > 0) {
          if (currentSyncId !== syncRef.current) return;
          const file = filesToDownload.shift();
          if (!file) continue;

          try {
            let blob = null;

            if (file.mimeType.startsWith('application/vnd.google-apps.')) {
              // Google Workspace doc → export to Office/PDF format
              let exportMimeType = 'application/pdf';
              if (file.mimeType === 'application/vnd.google-apps.document') {
                exportMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
              } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
                exportMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
              } else if (file.mimeType === 'application/vnd.google-apps.presentation') {
                exportMimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
              }

              const res = await fetch(
                `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportMimeType)}`,
                { headers: { Authorization: `Bearer ${accessToken}` }, signal }
              );
              if (res.ok) {
                blob = await res.blob();
              } else {
                console.warn(`Export failed for ${file.name}: ${res.status}`);
              }
            } else {
              // Regular binary file → download directly
              const res = await fetch(
                `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
                { headers: { Authorization: `Bearer ${accessToken}` }, signal }
              );
              if (res.ok) {
                blob = await res.blob();
              } else {
                console.warn(`Download failed for ${file.name}: ${res.status}`);
              }
            }

            if (currentSyncId !== syncRef.current) return;

            if (blob) {
              await saveFileBackup({
                id: file.id,
                name: file.name,
                mimeType: file.mimeType,
                size: file.size,
                modifiedTime: file.modifiedTime,
                parents: file.parents || [],
                trashed: file.trashed
              }, blob, userId);

              downloadCount++;
              setSyncProgress(prev => ({ ...prev, current: downloadCount }));
              setSyncStatus(`Syncing backups (${downloadCount}/${totalToDownload}): ${file.name}`);

              // Update display for trashed/permanently_deleted files after each download
              if (file.trashed) {
                const currentBackups = await getAllBackupFiles(userId);
                if (currentSyncId !== syncRef.current) return;
                const displayList = currentBackups
                  .filter(f => f.status === 'trashed' || f.status === 'permanently_deleted')
                  .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
                setFiles(displayList);
              }
            } else {
              failedCount++;
            }
          } catch (err) {
            if (err.name === 'AbortError') return;
            console.error(`Error downloading file ${file.name}:`, err);
            failedCount++;
          }
        }
      };

      const workerCount = Math.min(3, totalToDownload);
      const workers = Array.from({ length: workerCount }, () => downloadWorker());
      await Promise.all(workers);

      if (currentSyncId === syncRef.current) {
        const finalBackups = await getAllBackupFiles(userId);
        if (currentSyncId === syncRef.current) {
          const finalDeleted = finalBackups
            .filter(f => f.status === 'trashed' || f.status === 'permanently_deleted')
            .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
          const finalActive = finalBackups
            .filter(f => f.status === 'active')
            .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
          setFiles(finalDeleted);
          setActiveFiles(finalActive);
        }
        if (failedCount > 0) {
          setSyncStatus(`Sync complete! ${downloadCount} files backed up, ${failedCount} failed.`);
        } else {
          setSyncStatus(`Sync complete! ${downloadCount} files backed up.`);
        }
        setTimeout(() => {
          if (currentSyncId === syncRef.current) {
            setSyncStatus('');
          }
        }, 4000);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Error during sync:', err);
      if (currentSyncId === syncRef.current) {
        setError(`Failed to sync: ${err.message}`);
      }
    } finally {
      if (currentSyncId === syncRef.current) {
        setSyncing(false);
      }
    }
  }, [accessToken, userId]);

  // Auto-sync on first load
  useEffect(() => {
    let active = true;

    const loadAndSync = async () => {
      try {
        await loadCachedFiles();
      } catch (e) {
        console.error('Failed to load initial cache:', e);
      } finally {
        if (active) setLoading(false);
      }
      if (active) syncGoogleDrive();
    };

    loadAndSync();

    return () => {
      active = false;
      syncRef.current++;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [loadCachedFiles, syncGoogleDrive]);

  const handleRestore = async (fileId) => {
    try {
      const file = files.find(f => f.id === fileId);
      if (!file) return;

      setSyncing(true);
      setSyncStatus(`Restoring: ${file.name}...`);

      if (file.status === 'trashed') {
        // File is still in Drive Trash → just untrash it
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ trashed: false })
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Failed to untrash file: ${errText}`);
        }

        await updateFileStatus(fileId, 'active');
      } else if (file.status === 'permanently_deleted') {
        // File is gone from Drive → re-upload from local backup
        if (!file.backedUp || !file.blob) {
          throw new Error('No local backup copy available to restore this file');
        }

        // Check if parent folders still exist
        let parents = [];
        if (file.parents && file.parents.length > 0) {
          for (const parentId of file.parents) {
            try {
              const checkRes = await fetch(
                `https://www.googleapis.com/drive/v3/files/${parentId}?fields=id,trashed`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
              );
              if (checkRes.ok) {
                const checkData = await checkRes.json();
                if (!checkData.trashed) {
                  parents.push(parentId);
                }
              }
            } catch (e) { /* parent not accessible */ }
          }
        }

        // Determine MIME types for upload
        const metadataMimeType = file.mimeType;
        let mediaMimeType = file.mimeType;
        if (file.mimeType.startsWith('application/vnd.google-apps.')) {
          if (file.mimeType === 'application/vnd.google-apps.document') {
            mediaMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
            mediaMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          } else if (file.mimeType === 'application/vnd.google-apps.presentation') {
            mediaMimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
          } else {
            mediaMimeType = 'application/pdf';
          }
        }

        const metadata = {
          name: file.name,
          mimeType: metadataMimeType
        };
        if (parents.length > 0) {
          metadata.parents = parents;
        }

        // Build multipart upload body
        const boundary = 'restore_boundary_' + Date.now();
        const multipartBlob = new Blob([
          `--${boundary}\r\n`,
          'Content-Type: application/json; charset=UTF-8\r\n\r\n',
          JSON.stringify(metadata),
          `\r\n--${boundary}\r\n`,
          `Content-Type: ${mediaMimeType}\r\n\r\n`,
          file.blob,
          `\r\n--${boundary}--`
        ], { type: `multipart/related; boundary=${boundary}` });

        const uploadRes = await fetch(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body: multipartBlob
          }
        );

        if (!uploadRes.ok) {
          const errMsg = await uploadRes.text();
          throw new Error(`Upload failed: ${errMsg}`);
        }

        const uploadData = await uploadRes.json();

        // Remove old backup entry (it has the old file ID)
        await deleteBackupFile(fileId);

        // Save new file entry with the new Drive file ID
        const newFileRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${uploadData.id}?fields=id,name,mimeType,modifiedTime,size,parents`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (newFileRes.ok) {
          const newFileData = await newFileRes.json();
          await saveFileBackup(newFileData, file.blob, userId);
        }
      }

      await syncGoogleDrive();
    } catch (err) {
      console.error('Error restoring file:', err);
      alert(`Restore failed: ${err.message}`);
      setSyncing(false);
      setSyncStatus('');
    }
  };

  const getDownloadFilename = (file) => {
    let name = file.name;
    const mime = file.mimeType || '';
    // Add extension for Google Workspace docs
    if (mime === 'application/vnd.google-apps.document' && !name.endsWith('.docx')) {
      name += '.docx';
    } else if (mime === 'application/vnd.google-apps.spreadsheet' && !name.endsWith('.xlsx')) {
      name += '.xlsx';
    } else if (mime === 'application/vnd.google-apps.presentation' && !name.endsWith('.pptx')) {
      name += '.pptx';
    } else if (mime === 'application/vnd.google-apps.drawing' && !name.endsWith('.pdf')) {
      name += '.pdf';
    } else if (mime.startsWith('application/vnd.google-apps.') && !name.includes('.')) {
      name += '.pdf';
    }
    return name;
  };

  const handleDownload = async (file) => {
    try {
      if (file.status === 'permanently_deleted') {
        if (!file.backedUp || !file.blob) {
          throw new Error('No local backup copy available for download');
        }
        // Download from local IndexedDB backup
        const url = URL.createObjectURL(file.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = getDownloadFilename(file);
        document.body.appendChild(link);
        link.click();
        link.parentNode.removeChild(link);
        URL.revokeObjectURL(url);
      } else {
        // Download from Google Drive directly
        let downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
        if (file.mimeType?.startsWith('application/vnd.google-apps.')) {
          let exportMimeType = 'application/pdf';
          if (file.mimeType === 'application/vnd.google-apps.document') {
            exportMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
            exportMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          } else if (file.mimeType === 'application/vnd.google-apps.presentation') {
            exportMimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
          }
          downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
        }

        const res = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!res.ok) throw new Error('Failed to download file from Google Drive');

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = getDownloadFilename(file);
        document.body.appendChild(link);
        link.click();
        link.parentNode.removeChild(link);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Download error:', err);
      alert(`Download failed: ${err.message}`);
    }
  };

  const handleRestoreAll = async () => {
    const recoverableFiles = files.filter(f => f.status === 'trashed' || (f.status === 'permanently_deleted' && f.backedUp));
    if (recoverableFiles.length === 0) {
      alert('No recoverable files found.');
      return;
    }

    const confirmRestore = window.confirm(
      `Are you sure you want to restore all ${recoverableFiles.length} recoverable files to Google Drive?`
    );
    if (!confirmRestore) return;

    setSyncing(true);
    let successCount = 0;
    let failCount = 0;

    for (const file of recoverableFiles) {
      try {
        setSyncStatus(`Restoring (${successCount + 1}/${recoverableFiles.length}): ${file.name}...`);

        if (file.status === 'trashed') {
          const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?supportsAllDrives=true`, {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ trashed: false })
          });
          if (res.ok) {
            await updateFileStatus(file.id, 'active');
            successCount++;
          } else {
            failCount++;
          }
        } else if (file.status === 'permanently_deleted' && file.backedUp && file.blob) {
          // Re-upload from backup
          let parents = [];
          if (file.parents && file.parents.length > 0) {
            for (const parentId of file.parents) {
              try {
                const checkRes = await fetch(
                  `https://www.googleapis.com/drive/v3/files/${parentId}?fields=id,trashed`,
                  { headers: { Authorization: `Bearer ${accessToken}` } }
                );
                if (checkRes.ok) {
                  const checkData = await checkRes.json();
                  if (!checkData.trashed) parents.push(parentId);
                }
              } catch (e) { }
            }
          }

          const metadataMimeType = file.mimeType;
          let mediaMimeType = file.mimeType;
          if (file.mimeType.startsWith('application/vnd.google-apps.')) {
            if (file.mimeType === 'application/vnd.google-apps.document') {
              mediaMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
              mediaMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            } else if (file.mimeType === 'application/vnd.google-apps.presentation') {
              mediaMimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
            } else {
              mediaMimeType = 'application/pdf';
            }
          }

          const metadata = { name: file.name, mimeType: metadataMimeType };
          if (parents.length > 0) metadata.parents = parents;

          const boundary = 'restore_all_boundary_' + Date.now();
          const multipartBlob = new Blob([
            `--${boundary}\r\n`,
            'Content-Type: application/json; charset=UTF-8\r\n\r\n',
            JSON.stringify(metadata),
            `\r\n--${boundary}\r\n`,
            `Content-Type: ${mediaMimeType}\r\n\r\n`,
            file.blob,
            `\r\n--${boundary}--`
          ], { type: `multipart/related; boundary=${boundary}` });

          const uploadRes = await fetch(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`
              },
              body: multipartBlob
            }
          );

          if (uploadRes.ok) {
            const uploadData = await uploadRes.json();
            await deleteBackupFile(file.id);
            const newFileRes = await fetch(
              `https://www.googleapis.com/drive/v3/files/${uploadData.id}?fields=id,name,mimeType,modifiedTime,size,parents`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            if (newFileRes.ok) {
              const newFileData = await newFileRes.json();
              await saveFileBackup(newFileData, file.blob, userId);
            }
            successCount++;
          } else {
            failCount++;
          }
        }
      } catch (err) {
        console.error(`Error restoring file ${file.name}:`, err);
        failCount++;
      }
    }

    alert(`Restore complete: ${successCount} succeeded, ${failCount} failed out of ${recoverableFiles.length} files.`);
    await syncGoogleDrive();
  };

  const handleHeaderClick = (field) => {
    if (sortBy === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
  };

  const toggleGroup = (groupKey) => {
    setExpandedGroups(prev => ({
      ...prev,
      [groupKey]: !prev[groupKey]
    }));
  };

  const getFileCategory = (mimeType, name) => {
    const mime = (mimeType || '').toLowerCase();
    const ext = name.split('.').pop().toLowerCase();

    if (mime.startsWith('image/')) return 'Images';
    if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv') || ext === 'csv' || ext === 'xlsx' || ext === 'xls') return 'Spreadsheets';
    if (mime.includes('presentation') || mime.includes('powerpoint') || ext === 'pptx' || ext === 'ppt') return 'Presentations';
    if (mime.includes('pdf') || ext === 'pdf') return 'PDF Documents';
    if (mime.includes('document') || mime.includes('text') || ext === 'docx' || ext === 'doc' || ext === 'txt') return 'Documents';
    if (mime.includes('video/') || ext === 'mp4' || ext === 'mkv' || ext === 'avi') return 'Audio & Video';
    if (mime.includes('audio/') || ext === 'mp3' || ext === 'wav' || ext === 'ogg') return 'Audio & Video';
    if (mime.includes('zip') || mime.includes('rar') || mime.includes('compressed') || mime.includes('archive') || ext === 'zip' || ext === 'rar' || ext === '7z' || ext === 'tar' || ext === 'gz') return 'Archives';
    return 'Other Files';
  };

  const getFileDateBucket = (dateString) => {
    if (!dateString) return 'Unknown Date';
    const date = new Date(dateString);
    const now = new Date();
    
    const dateZero = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const todayZero = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const diffTime = todayZero - dateZero;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays <= 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays <= 7) return 'This Week';
    if (diffDays <= 30) return 'This Month';
    return 'Older';
  };

  const getFileStatusLabel = (file) => {
    if (file.status === 'trashed') return 'In Drive Trash';
    if (file.status === 'permanently_deleted') {
      return file.backedUp ? 'Deleted Forever (Recoverable)' : 'Deleted Forever (Unrecoverable)';
    }
    return 'Active (Backed Up)';
  };

  const sortFiles = (filesList) => {
    return [...filesList].sort((a, b) => {
      let valA, valB;
      if (sortBy === 'name') {
        valA = (a.name || '').toLowerCase();
        valB = (b.name || '').toLowerCase();
      } else if (sortBy === 'size') {
        valA = parseInt(a.size || '0');
        valB = parseInt(b.size || '0');
      } else if (sortBy === 'mimeType') {
        valA = (a.mimeType || '').toLowerCase();
        valB = (b.mimeType || '').toLowerCase();
      } else {
        valA = new Date(a.modifiedTime || 0);
        valB = new Date(b.modifiedTime || 0);
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
  };

  const groupFiles = (filesList) => {
    const groups = {};
    filesList.forEach(file => {
      let key = 'Other';
      if (groupBy === 'category') {
        key = getFileCategory(file.mimeType, file.name);
      } else if (groupBy === 'date') {
        key = getFileDateBucket(file.modifiedTime);
      } else if (groupBy === 'status') {
        key = getFileStatusLabel(file);
      }
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(file);
    });
    return groups;
  };

  const getOrderedGroupKeys = (groups) => {
    const keys = Object.keys(groups);
    if (groupBy === 'date') {
      const order = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older', 'Unknown Date'];
      return keys.sort((a, b) => {
        const idxA = order.indexOf(a);
        const idxB = order.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });
    }
    if (groupBy === 'category') {
      const order = ['Documents', 'Spreadsheets', 'Presentations', 'PDF Documents', 'Images', 'Audio & Video', 'Archives', 'Other Files'];
      return keys.sort((a, b) => {
        const idxA = order.indexOf(a);
        const idxB = order.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });
    }
    if (groupBy === 'status') {
      const order = ['In Drive Trash', 'Deleted Forever (Recoverable)', 'Deleted Forever (Unrecoverable)', 'Active (Backed Up)'];
      return keys.sort((a, b) => {
        const idxA = order.indexOf(a);
        const idxB = order.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });
    }
    return keys.sort();
  };

  const deletedFiles = files;
  const filteredDeletedFiles = sortFiles(
    deletedFiles.filter(file =>
      (file.name || '').toLowerCase().includes(searchQuery.toLowerCase())
    )
  );
  const filteredActiveFiles = sortFiles(
    activeFiles.filter(file =>
      (file.name || '').toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  const trashedCount = deletedFiles.filter(f => f.status === 'trashed').length;
  const permanentlyDeletedCount = deletedFiles.filter(f => f.status === 'permanently_deleted').length;
  const recoverableCount = deletedFiles.filter(f => f.status === 'permanently_deleted' && f.backedUp).length;

  return (
    <div className="dashboard-container">
      {/* Header */}
      <header className="header glass-panel" style={{ padding: '20px' }}>
        <div className="profile-section">
          {userProfile?.picture ? (
            <img src={userProfile.picture} alt="Profile" className="profile-pic" referrerPolicy="no-referrer" />
          ) : (
            <div className="profile-pic" style={{ backgroundColor: 'var(--surface-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px' }}>
              {userProfile?.name?.charAt(0)?.toUpperCase() || '?'}
            </div>
          )}
          <div className="profile-info">
            <h2>{userProfile?.name || 'User'}</h2>
            <p>{userProfile?.email || 'Logged In'}</p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            className="btn btn-success"
            onClick={syncGoogleDrive}
            title="Sync & Refresh backups"
            disabled={syncing || loading}
          >
            <RefreshCw size={18} className={syncing ? 'spin' : ''} />
            Sync
          </button>
          <button className="btn btn-danger" onClick={onLogout} disabled={loading}>
            <LogOut size={18} />
            Logout
          </button>
        </div>
      </header>

      {/* Stats Bar */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '12px',
        marginBottom: '24px',
        animation: 'fadeIn 0.4s ease-out'
      }}>
        <div className="glass-panel" style={{ padding: '16px', textAlign: 'center' }}>
          <Trash2 size={20} color="var(--accent-color)" />
          <div style={{ fontSize: '24px', fontWeight: '700', marginTop: '4px' }}>{trashedCount}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>In Trash</div>
        </div>
        <div className="glass-panel" style={{ padding: '16px', textAlign: 'center' }}>
          <AlertTriangle size={20} color="var(--danger-color)" />
          <div style={{ fontSize: '24px', fontWeight: '700', marginTop: '4px' }}>{permanentlyDeletedCount}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Deleted Forever</div>
        </div>
        <div className="glass-panel" style={{ padding: '16px', textAlign: 'center' }}>
          <FileCheck size={20} color="var(--success-color)" />
          <div style={{ fontSize: '24px', fontWeight: '700', marginTop: '4px' }}>{recoverableCount}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Recoverable</div>
        </div>
        <div className="glass-panel" style={{ padding: '16px', textAlign: 'center' }}>
          <Clock size={20} color="var(--text-secondary)" />
          <div style={{ fontSize: '24px', fontWeight: '700', marginTop: '4px' }}>{activeFiles.length}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Active (Backed Up)</div>
        </div>
      </div>

      {/* Section Header */}
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Trash2 size={24} color="var(--accent-color)" />
            Deleted & Trashed Files
          </h3>
          <p style={{ color: 'var(--text-secondary)', marginTop: '8px', fontSize: '14px' }}>
            Files in Drive Trash and permanently deleted files that are backed up locally in your browser.
          </p>
        </div>
        {deletedFiles.length > 0 && !loading && (
          <button className="btn btn-success" onClick={handleRestoreAll} disabled={syncing}>
            <RotateCcw size={18} />
            Restore All
          </button>
        )}
      </div>

      {/* Sync Progress */}
      {syncStatus && (
        <div className="glass-panel" style={{
          padding: '12px 20px', marginBottom: '24px',
          display: 'flex', alignItems: 'center', gap: '12px',
          borderLeft: '4px solid var(--accent-color)',
          animation: 'fadeIn 0.3s ease'
        }}>
          <div className="loader" style={{ margin: 0, width: '16px', height: '16px', borderWidth: '2px' }}></div>
          <span style={{ fontSize: '14px', color: 'var(--text-secondary)', flex: 1 }}>{syncStatus}</span>
          {syncProgress.total > 0 && (
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              {syncProgress.current}/{syncProgress.total}
            </span>
          )}
        </div>
      )}

      {/* Search & Controls */}
      {(deletedFiles.length > 0 || activeFiles.length > 0) && (
        <div className="controls-bar glass-panel" style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '16px',
          padding: '16px',
          marginBottom: '24px',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          {/* Search Box */}
          <div style={{ flex: '1', minWidth: '200px' }}>
            <input
              type="text"
              placeholder="Search files by name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 16px',
                borderRadius: '8px',
                border: '1px solid var(--surface-border)',
                background: 'rgba(0,0,0,0.2)',
                color: 'var(--text-primary)',
                fontSize: '14px',
                outline: 'none',
                transition: 'border-color 0.2s ease',
                boxSizing: 'border-box'
              }}
            />
          </div>

          {/* Filters & Arrangement Options */}
          <div className="arrangement-options" style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            flexWrap: 'wrap'
          }}>
            {/* Group By Select */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Group:</span>
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
                className="select-control"
                style={{
                  background: 'var(--surface-color)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--surface-border)',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '13px',
                  outline: 'none',
                  cursor: 'pointer'
                }}
              >
                <option value="none">None</option>
                <option value="category">File Type</option>
                <option value="status">Status</option>
                <option value="date">Date Modified</option>
              </select>
            </div>

            {/* Sort By Select */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Sort:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="select-control"
                style={{
                  background: 'var(--surface-color)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--surface-border)',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '13px',
                  outline: 'none',
                  cursor: 'pointer'
                }}
              >
                <option value="modifiedTime">Date Modified</option>
                <option value="name">Name</option>
                <option value="size">Size</option>
                <option value="mimeType">Type</option>
              </select>
            </div>

            {/* Sort Order Button */}
            <button
              className="btn btn-toggle-order"
              onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
              title={`Sort ${sortOrder === 'asc' ? 'Ascending' : 'Descending'}`}
              style={{
                padding: '8px 12px',
                background: 'var(--surface-color)',
                border: '1px solid var(--surface-border)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: '600'
              }}
            >
              {sortOrder === 'asc' ? 'Asc' : 'Desc'}
            </button>

            {/* Layout Toggle */}
            <div className="layout-toggle-buttons" style={{
              display: 'flex',
              background: 'rgba(0,0,0,0.2)',
              borderRadius: '8px',
              padding: '4px',
              border: '1px solid var(--surface-border)'
            }}>
              <button
                onClick={() => setLayoutView('grid')}
                className={`layout-btn ${layoutView === 'grid' ? 'active' : ''}`}
                style={{
                  background: layoutView === 'grid' ? 'var(--accent-color)' : 'transparent',
                  border: 'none',
                  color: layoutView === 'grid' ? '#fff' : 'var(--text-secondary)',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Grid view"
              >
                <LayoutGrid size={16} />
              </button>
              <button
                onClick={() => setLayoutView('list')}
                className={`layout-btn ${layoutView === 'list' ? 'active' : ''}`}
                style={{
                  background: layoutView === 'list' ? 'var(--accent-color)' : 'transparent',
                  border: 'none',
                  color: layoutView === 'list' ? '#fff' : 'var(--text-secondary)',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="List view"
              >
                <List size={16} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View Toggle */}
      <div style={{ marginBottom: '16px', display: 'flex', gap: '8px' }}>
        <button
          className={`btn ${!showActiveFiles ? '' : 'btn-toggle'}`}
          onClick={() => setShowActiveFiles(false)}
          style={!showActiveFiles ? { background: 'var(--accent-color)', color: '#fff' } : { background: 'transparent', border: '1px solid var(--surface-border)', color: 'var(--text-secondary)' }}
        >
          <Trash2 size={16} />
          Deleted ({deletedFiles.length})
        </button>
        <button
          className={`btn ${showActiveFiles ? '' : 'btn-toggle'}`}
          onClick={() => setShowActiveFiles(true)}
          style={showActiveFiles ? { background: 'var(--accent-color)', color: '#fff' } : { background: 'transparent', border: '1px solid var(--surface-border)', color: 'var(--text-secondary)' }}
        >
          <FileCheck size={16} />
          Active Backups ({activeFiles.length})
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="empty-state glass-panel">
          <div className="loader"></div>
          <p style={{ marginTop: '16px' }}>Loading application...</p>
        </div>
      ) : error ? (
        <div className="empty-state glass-panel" style={{ color: 'var(--danger-color)' }}>
          <p>{error}</p>
          <button className="btn" style={{ marginTop: '16px' }} onClick={syncGoogleDrive}>Try Again</button>
        </div>
      ) : (
        (() => {
          const activeList = showActiveFiles ? filteredActiveFiles : filteredDeletedFiles;
          
          if (showActiveFiles) {
            if (activeFiles.length === 0) {
              return (
                <div className="empty-state glass-panel">
                  <FileCheck size={48} />
                  <h3>No Active Backups Yet</h3>
                  <p>Run a sync to back up your active Google Drive files. Once backed up, if they are deleted in the future, you can recover them here.</p>
                </div>
              );
            }
          } else {
            if (deletedFiles.length === 0) {
              return (
                <div className="empty-state glass-panel">
                  <Trash2 size={48} />
                  <h3>{syncing ? 'Fetching Google Drive Files...' : 'No Trashed or Deleted Files Found'}</h3>
                  <p>{syncing ? 'Backups are being loaded. Please wait...' : 'Your Google Drive trash is empty and no locally backed-up deleted files were found.'}</p>
                </div>
              );
            }
          }

          if (activeList.length === 0) {
            return (
              <div className="empty-state glass-panel">
                {showActiveFiles ? <FileCheck size={48} /> : <Trash2 size={48} />}
                <h3>No Matching Files Found</h3>
                <p>No results for &quot;{searchQuery}&quot;. Try a different search.</p>
              </div>
            );
          }

          // We have files to show!
          const renderList = (filesToRender) => {
            if (layoutView === 'list') {
              return (
                <div className="files-table-container glass-panel" style={{ overflowX: 'auto' }}>
                  <table className="files-table">
                    <thead>
                      <tr>
                        <th onClick={() => handleHeaderClick('name')} className="sortable-header">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            Name {sortBy === 'name' && (sortOrder === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
                          </div>
                        </th>
                        <th onClick={() => handleHeaderClick('mimeType')} className="sortable-header">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            Type {sortBy === 'mimeType' && (sortOrder === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
                          </div>
                        </th>
                        <th onClick={() => handleHeaderClick('size')} className="sortable-header">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            Size {sortBy === 'size' && (sortOrder === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
                          </div>
                        </th>
                        <th onClick={() => handleHeaderClick('modifiedTime')} className="sortable-header">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            Modified {sortBy === 'modifiedTime' && (sortOrder === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
                          </div>
                        </th>
                        <th>Status</th>
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupBy === 'none' ? (
                        filesToRender.map(file => (
                          <FileItem
                            key={file.id}
                            file={file}
                            layoutView={layoutView}
                            onRestore={handleRestore}
                            onDownload={handleDownload}
                          />
                        ))
                      ) : (
                        (() => {
                          const groups = groupFiles(filesToRender);
                          const orderedKeys = getOrderedGroupKeys(groups);
                          return orderedKeys.map(groupKey => {
                            const groupFilesList = groups[groupKey];
                            const isExpanded = expandedGroups[groupKey] !== false;
                            return (
                              <Fragment key={groupKey}>
                                <tr className="group-header-row" onClick={() => toggleGroup(groupKey)} style={{ cursor: 'pointer' }}>
                                  <td colSpan={6}>
                                    <div className="group-header-content" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 8px' }}>
                                      {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                      <span style={{ fontWeight: '600' }}>{groupKey}</span>
                                      <span className="badge badge-info" style={{ marginLeft: '4px' }}>{groupFilesList.length}</span>
                                    </div>
                                  </td>
                                </tr>
                                {isExpanded && groupFilesList.map(file => (
                                  <FileItem
                                    key={file.id}
                                    file={file}
                                    layoutView={layoutView}
                                    onRestore={handleRestore}
                                    onDownload={handleDownload}
                                  />
                                ))}
                              </Fragment>
                            );
                          });
                        })()
                      )}
                    </tbody>
                  </table>
                </div>
              );
            }

            // Grid View
            if (groupBy === 'none') {
              return (
                <div className="files-grid">
                  {filesToRender.map(file => (
                    <FileItem
                      key={file.id}
                      file={file}
                      layoutView={layoutView}
                      onRestore={handleRestore}
                      onDownload={handleDownload}
                    />
                  ))}
                </div>
              );
            }

            // Grouped Grid View
            const groups = groupFiles(filesToRender);
            const orderedKeys = getOrderedGroupKeys(groups);
            return (
              <div className="grouped-grid-container">
                {orderedKeys.map(groupKey => {
                  const groupFilesList = groups[groupKey];
                  const isExpanded = expandedGroups[groupKey] !== false;
                  return (
                    <div key={groupKey} className="group-section" style={{ marginBottom: '24px' }}>
                      <div
                        className="group-section-header glass-panel"
                        onClick={() => toggleGroup(groupKey)}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '12px 20px',
                          cursor: 'pointer',
                          borderRadius: '8px',
                          marginBottom: isExpanded ? '16px' : '0'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                          <span style={{ fontWeight: '600', fontSize: '15px' }}>{groupKey}</span>
                        </div>
                        <span className="badge badge-info">{groupFilesList.length} files</span>
                      </div>
                      {isExpanded && (
                        <div className="files-grid">
                          {groupFilesList.map(file => (
                            <FileItem
                              key={file.id}
                              file={file}
                              layoutView={layoutView}
                              onRestore={handleRestore}
                              onDownload={handleDownload}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          };

          return renderList(activeList);
        })()
      )}
    </div>
  );
}

export default Dashboard;
