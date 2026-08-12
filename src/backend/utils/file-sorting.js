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

const compareFiles = (left, right, sort = 'name', order = 'asc', directoriesFirst = false) => {
  if (directoriesFirst && Boolean(left?.isDirectory) !== Boolean(right?.isDirectory)) {
    return left?.isDirectory ? -1 : 1;
  }
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

const sortFiles = (files, sort = 'name', order = 'asc', directoriesFirst = false) =>
  [...(Array.isArray(files) ? files : [])].sort((left, right) => compareFiles(left, right, sort, order, directoriesFirst));

const normalizeSort = (sort, order, directoriesFirst) => ({
  sort: ['name', 'modified', 'size', 'directory'].includes(sort) ? sort : 'name',
  order: order === 'desc' ? 'desc' : 'asc',
  directoriesFirst: directoriesFirst === true || directoriesFirst === 'true'
});

module.exports = {
  compareFiles,
  modifiedTimestamp,
  normalizeSort,
  sortFiles
};
