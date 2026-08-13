const path = require('path');

const dedupeFilename = (filename, attempt) => {
  const parsed = path.parse(filename);
  if (parsed.base.toLowerCase().endsWith('.tar.gz')) {
    return `${parsed.base.slice(0, -7)}_(${attempt}).tar.gz`;
  }
  return parsed.ext
    ? `${parsed.name}_(${attempt})${parsed.ext}`
    : `${parsed.name}_(${attempt})`;
};

const nextAvailablePath = async (requestedPath, exists) => {
  if (!(await exists(requestedPath))) return requestedPath;

  let attempt = 1;
  while (true) {
    const candidate = path.join(
      path.dirname(requestedPath),
      dedupeFilename(path.basename(requestedPath), attempt),
    );
    if (!(await exists(candidate))) return candidate;
    attempt += 1;
  }
};

module.exports = { dedupeFilename, nextAvailablePath };
