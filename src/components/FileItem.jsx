import { File, Download, RotateCcw, AlertTriangle, CloudOff, FileText, Image, FileSpreadsheet, FileVideo, FileAudio, Archive } from 'lucide-react';

function FileItem({ file, layoutView, onRestore, onDownload }) {
  const isPermanentlyDeleted = file.status === 'permanently_deleted';
  const isUnrecoverable = isPermanentlyDeleted && !file.backedUp;

  const handleDownloadClick = () => {
    if (onDownload) {
      onDownload(file);
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return 'Unknown size';
    const numBytes = parseInt(bytes);
    if (numBytes === 0) return '0 Bytes';
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(numBytes) / Math.log(1024));
    return Math.round((numBytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'Unknown date';
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const getFileIcon = (size = 32) => {
    const mime = file.mimeType || '';
    if (mime.startsWith('image/')) return <Image size={size} />;
    if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) return <FileSpreadsheet size={size} />;
    if (mime.includes('presentation') || mime.includes('powerpoint')) return <FileText size={size} />;
    if (mime.includes('video/')) return <FileVideo size={size} />;
    if (mime.includes('audio/')) return <FileAudio size={size} />;
    if (mime.includes('zip') || mime.includes('rar') || mime.includes('compressed') || mime.includes('archive')) return <Archive size={size} />;
    if (mime.includes('pdf') || mime.includes('document') || mime.includes('text')) return <FileText size={size} />;
    return <File size={size} />;
  };

  const getFileTypeLabel = (mimeType) => {
    if (!mimeType) return 'Unknown';
    if (mimeType === 'application/vnd.google-apps.document') return 'Google Doc';
    if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'Google Sheet';
    if (mimeType === 'application/vnd.google-apps.presentation') return 'Google Slide';
    if (mimeType === 'application/vnd.google-apps.drawing') return 'Google Drawing';
    if (mimeType.startsWith('application/vnd.google-apps.')) return 'Google Workspace';
    const parts = mimeType.split('/');
    return parts[parts.length - 1].toUpperCase();
  };

  if (layoutView === 'list') {
    return (
      <tr className={`file-row ${isPermanentlyDeleted ? 'deleted-forever' : ''}`}>
        <td className="file-name-cell" title={file.name}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span className="file-icon-inline" style={{ color: isPermanentlyDeleted ? 'var(--danger-color)' : 'var(--accent-color)', display: 'flex' }}>
              {isUnrecoverable ? <CloudOff size={18} /> : getFileIcon(18)}
            </span>
            <span className="file-name-text">{file.name}</span>
          </div>
        </td>
        <td>{getFileTypeLabel(file.mimeType)}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{formatSize(file.size)}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(file.modifiedTime)}</td>
        <td>
          {isPermanentlyDeleted ? (
            isUnrecoverable ? (
              <span className="badge badge-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                <CloudOff size={10} />
                No Backup
              </span>
            ) : (
              <span className="badge badge-warning" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                <AlertTriangle size={10} />
                Recoverable
              </span>
            )
          ) : (
            <span className="badge badge-info" style={{ whiteSpace: 'nowrap' }}>
              In Trash
            </span>
          )}
        </td>
        <td>
          <div className="file-actions-inline" style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              className="btn btn-success btn-xs"
              onClick={() => onRestore(file.id)}
              disabled={isUnrecoverable}
              title={isUnrecoverable ? 'Cannot restore file without a local backup' : 'Restore file to Google Drive'}
            >
              <RotateCcw size={14} />
              Restore
            </button>
            <button
              className="btn btn-xs"
              onClick={handleDownloadClick}
              disabled={isUnrecoverable}
              title={isUnrecoverable ? 'Cannot download file without a local backup' : 'Download a copy to your computer'}
            >
              <Download size={14} />
              Download
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <div className={`file-card glass-panel ${isPermanentlyDeleted ? 'deleted-forever' : ''}`}>
      <div className="file-icon" style={{ color: isPermanentlyDeleted ? 'var(--danger-color)' : 'var(--accent-color)' }}>
        {isUnrecoverable ? <CloudOff size={32} /> : getFileIcon(32)}
      </div>

      <div className="file-name" title={file.name}>
        {file.name}
      </div>

      <div style={{ margin: '8px 0' }}>
        {isPermanentlyDeleted ? (
          isUnrecoverable ? (
            <span className="badge badge-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <CloudOff size={12} />
              Permanently Deleted (No Backup)
            </span>
          ) : (
            <span className="badge badge-warning" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <AlertTriangle size={12} />
              Deleted Forever (Recoverable)
            </span>
          )
        ) : (
          <span className="badge badge-info">
            In Drive Trash
          </span>
        )}
      </div>

      <div className="file-meta">
        <p>Type: {getFileTypeLabel(file.mimeType)}</p>
        <p>Size: {formatSize(file.size)}</p>
        <p>Modified: {formatDate(file.modifiedTime)}</p>
        {file.backedUp && (
          <p style={{ color: 'var(--success-color)', marginTop: '4px', fontSize: '11px' }}>✓ Backed up locally</p>
        )}
      </div>

      <div className="file-actions">
        <button
          className="btn btn-success"
          onClick={() => onRestore(file.id)}
          disabled={isUnrecoverable}
          title={isUnrecoverable ? 'Cannot restore file without a local backup' : 'Restore file to Google Drive'}
        >
          <RotateCcw size={16} />
          Restore
        </button>
        <button
          className="btn"
          onClick={handleDownloadClick}
          disabled={isUnrecoverable}
          title={isUnrecoverable ? 'Cannot download file without a local backup' : 'Download a copy to your computer'}
        >
          <Download size={16} />
          Download
        </button>
      </div>
    </div>
  );
}

export default FileItem;
