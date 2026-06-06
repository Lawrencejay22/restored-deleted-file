# Google Drive Restoration Tool

A premium, local-first web application designed to back up and restore permanently deleted Google Drive files. The application leverages Google Identity Services (GIS) for secure access and saves document/binary data locally in the browser's IndexedDB.

## 🚀 Key Features

### 1. Advanced File Arrangement Controls
- **Layout Toggles**: Switch between **Grid View** (rich visual cards) and **List View** (sleek, high-density table structure).
- **Interactive Sorting**: Sort files dynamically by **Name**, **Size**, **Date Modified**, and **Type** in both Ascending and Descending orders. Clicking column headers in List View automatically sorts the table.
- **Collapsible Grouping**: Organize files under custom groups:
  - **File Type**: Documents, Spreadsheets, Presentations, PDFs, Images, Audio & Video, Archives, and Other files.
  - **Status**: In Drive Trash, Deleted Forever (Recoverable), Deleted Forever (Unrecoverable), and Active Backups.
  - **Date Modified**: Today, Yesterday, This Week, This Month, and Older.

### 2. High-Performance Background Synchronization
- **Metadata Bulk Sync**: IndexedDB metadata caching is bulk-processed in under **0.1 seconds** for accounts with thousands of files.
- **Concurrent Download Worker Pool**: Downloads files in parallel (up to 3 workers) with automatic rate-limiting compliance.
- **Safety Caps**: Cap active file background downloads (focusing on the most recent 200 items) to prevent browser lock-ups or api quota exhaustion.

### 3. Compliant Multipart Restorations
- Fully implements the RFC-compliant `multipart/related` structure to upload file media along with metadata.
- Automatically resolves file formats during re-upload (e.g. converting exported Google Docs back into native native editable Google documents) without causing corruption.

---

## 🛠️ Tech Stack
- **Frontend**: React, Vite, CSS (Glassmorphism + Dark Mode), Lucide Icons
- **Database**: Browser IndexedDB (Local-first caching)
- **APIs**: Google Identity Services, Google Drive API v3

---

## 💻 How to Get Started

### Prerequisites
- Node.js installed on your machine.
- A Google Cloud Console project with OAuth 2.0 Credentials enabled for the Google Drive API.

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/Lawrencejay22/restored-deleted-file.git
   cd restored-deleted-file
   ```

2. Install client dependencies and run locally:
   ```bash
   npm install
   npm run dev
   ```

3. (Optional) Setup server backups:
   ```bash
   cd server
   npm install
   npm start
   ```
