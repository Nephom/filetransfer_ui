const compareNaturalNames = (left, right) =>
  String(left || '').localeCompare(String(right || ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  });

const modifiedTimestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const compareFiles = (left, right, sort = 'name', order = 'asc') => {
  const leftDirectory = Boolean(left?.isDirectory);
  const rightDirectory = Boolean(right?.isDirectory);

  // Directory-first is a fixed grouping rule; direction only changes the
  // selected field within each group.
  if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;

  let result;
  if (sort === 'modified') {
    result = modifiedTimestamp(left?.modified) - modifiedTimestamp(right?.modified);
  } else if (sort === 'size') {
    result = (Number(left?.size) || 0) - (Number(right?.size) || 0);
  } else {
    result = compareNaturalNames(left?.name, right?.name);
  }

  if (result === 0) {
    result = compareNaturalNames(left?.name, right?.name);
    if (result === 0) result = String(left?.path || '').localeCompare(String(right?.path || ''));
  }
  return order === 'desc' ? -result : result;
};

const sortFiles = (files, sort = 'name', order = 'asc') =>
  [...(Array.isArray(files) ? files : [])].sort((left, right) => compareFiles(left, right, sort, order));

const normalizeSort = (sort, order) => ({
  sort: ['name', 'modified', 'size', 'directory'].includes(sort) ? sort : 'name',
  order: order === 'desc' ? 'desc' : 'asc'
});

module.exports = {
  compareFiles,
  modifiedTimestamp,
  normalizeSort,
  sortFiles
};
