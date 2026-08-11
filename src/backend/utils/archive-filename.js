const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\x00-\x1F]/g;

const sanitizeFilenamePart = (value, fallback = 'archive') => {
  const sanitized = String(value || '')
    .replace(INVALID_FILENAME_CHARACTERS, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return sanitized || fallback;
};

const localTimestamp = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}_${pad(date.getMinutes())}_${pad(date.getSeconds())}`;
};

const archiveExtension = (format) => format === 'tar.gz' ? '.tar.gz' : '.zip';

const archiveFilename = (sessionName, format, date = new Date()) => {
  const extension = archiveExtension(format);
  const safeSessionName = sanitizeFilenamePart(sessionName, 'archive');
  return `${safeSessionName}_${localTimestamp(date)}${extension}`;
};

const contentDisposition = (filename) => {
  const encoded = encodeURIComponent(filename);
  const asciiFallback = filename.replace(/[^\x00-\x7F]/g, '_').replace(/"/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
};

module.exports = {
  archiveExtension,
  archiveFilename,
  contentDisposition,
  localTimestamp,
  sanitizeFilenamePart
};
