export const paneViewModeKey = 'pane-file-view-mode';
export const normalisePanePath = (value) => (value || '').replace(/^\/+|\/+$/g, '');
export const paneItemKey = (item) => item.path || item.name;
export const formatPaneSize = (size) => {
    if (!size) return size === 0 ? '0 B' : '--';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
    return `${(size / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
};
export const paneHeaders = (token, location) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(location?.id ? { 'X-Location-ID': location.id } : {}),
    ...(location?.revision ? { 'X-Location-Revision': location.revision } : {})
});
