import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Setup directories and database
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKUPS_DIR = path.join(__dirname, 'backups');
const DB_FILE = path.join(__dirname, 'database.json');

if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    return { users: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    return { users: {} };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Set up the OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// Warn if client secret is placeholder
if (!process.env.CLIENT_SECRET || process.env.CLIENT_SECRET === 'YOUR_CLIENT_SECRET_HERE') {
  console.warn('WARNING: CLIENT_SECRET is not configured in server/.env. Google OAuth authorization will fail.');
}

// 1. Generate Auth URL
app.get('/api/auth/url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Gives us a refresh token
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent' // Force to get refresh token
  });
  res.json({ url });
});

// 2. Exchange Code for Token
app.post('/api/auth/token', async (req, res) => {
  const { code } = req.body;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.json(tokens);
  } catch (error) {
    console.error('Error retrieving access token', error);
    res.status(500).json({ error: 'Failed to retrieve access token' });
  }
});

// Helper to get Google User ID
async function getUserId(client) {
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const userInfo = await oauth2.userinfo.get();
  return userInfo.data.id;
}

// Sync user's files and download backups
async function syncUserFiles(drive, userId) {
  const db = readDB();
  if (!db.users[userId]) {
    db.users[userId] = { files: {} };
  }
  const userFiles = db.users[userId].files;

  // 1. Fetch all files from Google Drive (active and trashed)
  let googleFiles = [];
  let pageToken = null;
  try {
    do {
      const res = await drive.files.list({
        // We only back up files. Folders can be metadata-tracked and auto-recreated.
        q: "mimeType != 'application/vnd.google-apps.folder'",
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size, parents, trashed)",
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken: pageToken,
        pageSize: 100
      });
      if (res.data.files) {
        googleFiles.push(...res.data.files);
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (error) {
    console.error('Error listing files from Google Drive:', error);
    throw error;
  }

  const googleFileIds = new Set(googleFiles.map(f => f.id));

  // 2. Identify permanently deleted files:
  // Any file in our database that is NOT in the active/trashed list from Google Drive
  // is considered permanently deleted.
  for (const fileId in userFiles) {
    if (!googleFileIds.has(fileId)) {
      if (userFiles[fileId].status !== 'permanently_deleted') {
        userFiles[fileId].status = 'permanently_deleted';
      }
    }
  }

  // 3. Sync and download/back up files that are in Google Drive
  for (const file of googleFiles) {
    const existingFile = userFiles[file.id];
    const status = file.trashed ? 'trashed' : 'active';
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';

    // If it's a new file, or file is modified, or status changed
    if (!existingFile || existingFile.modifiedTime !== file.modifiedTime || existingFile.status !== status) {
      const userBackupDir = path.join(BACKUPS_DIR, userId);
      if (!fs.existsSync(userBackupDir)) {
        fs.mkdirSync(userBackupDir, { recursive: true });
      }

      const localPath = path.join(userBackupDir, file.id);
      let backedUp = false;
      let localExtension = '';

      // Backup files up to 50MB
      const sizeLimit = 50 * 1024 * 1024;
      const fileSize = parseInt(file.size || '0');

      if (!isFolder && fileSize <= sizeLimit) {
        try {
          console.log(`[Backup] Backing up: ${file.name} (${file.id})`);
          if (file.mimeType.startsWith('application/vnd.google-apps.')) {
            // Google Workspace document - export to Microsoft Office or PDF
            let exportMimeType = 'application/pdf';
            localExtension = '.pdf';
            if (file.mimeType === 'application/vnd.google-apps.document') {
              exportMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
              localExtension = '.docx';
            } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
              exportMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
              localExtension = '.xlsx';
            } else if (file.mimeType === 'application/vnd.google-apps.presentation') {
              exportMimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
              localExtension = '.pptx';
            }

            const exportResponse = await drive.files.export({
              fileId: file.id,
              mimeType: exportMimeType
            }, { responseType: 'stream' });

            const dest = fs.createWriteStream(localPath + localExtension);
            await new Promise((resolve, reject) => {
              exportResponse.data
                .pipe(dest)
                .on('finish', resolve)
                .on('error', reject);
            });
            backedUp = true;
          } else {
            // Binary file - download directly
            const downloadResponse = await drive.files.get({
              fileId: file.id,
              alt: 'media'
            }, { responseType: 'stream' });

            const dest = fs.createWriteStream(localPath);
            await new Promise((resolve, reject) => {
              downloadResponse.data
                .pipe(dest)
                .on('finish', resolve)
                .on('error', reject);
            });
            backedUp = true;
          }
        } catch (downloadError) {
          console.error(`[Backup] Failed to back up file ${file.name}:`, downloadError.message);
        }
      }

      userFiles[file.id] = {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        modifiedTime: file.modifiedTime,
        parents: file.parents || [],
        localPath: backedUp ? localPath + localExtension : null,
        status: status,
        backedUp: backedUp
      };
    }
  }

  writeDB(db);
}

// Restore a file from trash or from backend backup
async function restoreFile(drive, userId, fileId) {
  const db = readDB();
  const userFiles = db.users[userId]?.files;
  if (!userFiles || !userFiles[fileId]) {
    throw new Error('File not found in database');
  }

  const fileMeta = userFiles[fileId];

  // Case 1: File is in Google Drive Trash -> Restore it directly using API
  if (fileMeta.status === 'trashed') {
    await drive.files.update({
      fileId: fileId,
      requestBody: { trashed: false }
    });
    fileMeta.status = 'active';
    writeDB(db);
    return { success: true, method: 'untrash' };
  }

  // Case 2: File is permanently deleted -> Re-upload from backup
  if (fileMeta.status === 'permanently_deleted') {
    if (!fileMeta.backedUp || !fileMeta.localPath || !fs.existsSync(fileMeta.localPath)) {
      throw new Error('No local backup file available for recovery');
    }

    // Try to find a valid parent folder
    let parents = [];
    if (fileMeta.parents && fileMeta.parents.length > 0) {
      for (const parentId of fileMeta.parents) {
        try {
          const parentCheck = await drive.files.get({ fileId: parentId, fields: 'id, trashed' });
          if (!parentCheck.data.trashed) {
            parents.push(parentId);
          }
        } catch (err) {
          // Parent folder deleted/inaccessible
        }
      }
    }

    // Upload restored file back to Drive
    const media = {
      mimeType: fileMeta.mimeType.startsWith('application/vnd.google-apps.')
        ? (fileMeta.localPath.endsWith('.docx')
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : fileMeta.localPath.endsWith('.xlsx')
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/pdf')
        : fileMeta.mimeType,
      body: fs.createReadStream(fileMeta.localPath)
    };

    const requestBody = {
      name: fileMeta.name,
      mimeType: fileMeta.mimeType.startsWith('application/vnd.google-apps.')
        ? (fileMeta.localPath.endsWith('.docx')
          ? 'application/vnd.google-apps.document'
          : fileMeta.localPath.endsWith('.xlsx')
            ? 'application/vnd.google-apps.spreadsheet'
            : 'application/vnd.google-apps.document')
        : fileMeta.mimeType
    };

    if (parents.length > 0) {
      requestBody.parents = parents;
    }

    const uploadResponse = await drive.files.create({
      requestBody,
      media: media,
      fields: 'id'
    });

    const newFileId = uploadResponse.data.id;

    // Fetch new file details to insert into database
    const newFileMeta = await drive.files.get({
      fileId: newFileId,
      fields: 'id, name, mimeType, modifiedTime, size, parents'
    });

    // Move/rename backup file to match new file ID
    const newLocalPath = path.join(BACKUPS_DIR, userId, newFileId);
    fs.copyFileSync(fileMeta.localPath, newLocalPath);

    userFiles[newFileId] = {
      id: newFileId,
      name: newFileMeta.data.name,
      mimeType: newFileMeta.data.mimeType,
      size: newFileMeta.data.size,
      modifiedTime: newFileMeta.data.modifiedTime,
      parents: newFileMeta.data.parents || [],
      localPath: newLocalPath,
      status: 'active',
      backedUp: true
    };

    // Delete old database entry and file backup
    delete userFiles[fileId];
    try {
      fs.unlinkSync(fileMeta.localPath);
    } catch (e) { }

    writeDB(db);
    return { success: true, method: 'upload', newFileId };
  }

  return { success: false, reason: 'File is already active' };
}

// 3. Fetch Trashed & Backup Files
app.post('/api/drive/trash', async (req, res) => {
  const { tokens } = req.body;

  const client = new google.auth.OAuth2(process.env.CLIENT_ID, process.env.CLIENT_SECRET);
  client.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth: client });

  try {
    const userId = await getUserId(client);

    // Sync Google Drive files to create backups and identify permanently deleted files
    await syncUserFiles(drive, userId);

    // Read synced files from database and filter for trashed/permanently deleted
    const db = readDB();
    const userFiles = db.users[userId]?.files || {};

    const displayFiles = Object.values(userFiles).filter(file =>
      file.status === 'trashed' || file.status === 'permanently_deleted'
    );

    res.json({ files: displayFiles });
  } catch (error) {
    console.error('Error listing/syncing trashed files:', error);
    res.status(500).json({ error: 'Failed to fetch trashed and deleted files' });
  }
});

// 4. Restore File (from trash or backup)
app.post('/api/drive/restore', async (req, res) => {
  const { tokens, fileId } = req.body;

  const client = new google.auth.OAuth2(process.env.CLIENT_ID, process.env.CLIENT_SECRET);
  client.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth: client });

  try {
    const userId = await getUserId(client);
    const result = await restoreFile(drive, userId, fileId);
    res.json(result);
  } catch (error) {
    console.error('Error restoring file:', error);
    res.status(500).json({ error: error.message || 'Failed to restore file' });
  }
});

// 5. Download File (from Drive or local backup)
app.post('/api/drive/download', async (req, res) => {
  const { tokens, fileId } = req.body;

  const client = new google.auth.OAuth2(process.env.CLIENT_ID, process.env.CLIENT_SECRET);
  client.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth: client });

  try {
    const userId = await getUserId(client);
    const db = readDB();
    const fileMeta = db.users[userId]?.files[fileId];

    if (fileMeta && fileMeta.status === 'permanently_deleted') {
      if (fileMeta.backedUp && fileMeta.localPath && fs.existsSync(fileMeta.localPath)) {
        res.setHeader('Content-Type', fileMeta.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileMeta.name)}"`);
        fs.createReadStream(fileMeta.localPath).pipe(res);
        return;
      } else {
        return res.status(404).json({ error: 'Local backup file not found' });
      }
    }

    // Otherwise, download directly from Google Drive
    const response = await drive.files.get({
      fileId: fileId,
      alt: 'media'
    }, { responseType: 'stream' });

    res.setHeader('Content-Type', response.headers['content-type']);
    res.setHeader('Content-Disposition', `attachment`);
    response.data.pipe(res);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// 6. Get User Profile
app.post('/api/auth/profile', async (req, res) => {
  const { tokens } = req.body;

  const client = new google.auth.OAuth2(process.env.CLIENT_ID, process.env.CLIENT_SECRET);
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });

  try {
    const userInfo = await oauth2.userinfo.get();
    res.json(userInfo.data);
  } catch (error) {
    console.error('Error fetching user profile', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
