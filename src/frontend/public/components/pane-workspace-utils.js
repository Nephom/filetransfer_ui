import React from 'react';

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

export const usePaneMenuPosition = (menu, offsetX = 0) => {
    const menuRef = React.useRef(null);
    const [position, setPosition] = React.useState(null);

    React.useLayoutEffect(() => {
        if (!menu) {
            setPosition(null);
            return undefined;
        }

        const updatePosition = () => {
            const element = menuRef.current;
            if (!element) return;
            const rectangle = element.getBoundingClientRect();
            const left = Math.min(Math.max(8, menu.x + offsetX), Math.max(8, window.innerWidth - rectangle.width - 8));
            const top = Math.min(Math.max(8, menu.y), Math.max(8, window.innerHeight - rectangle.height - 8));
            setPosition({ left, top });
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.visualViewport?.addEventListener('resize', updatePosition);
        const observer = window.ResizeObserver ? new ResizeObserver(updatePosition) : null;
        if (observer && menuRef.current) observer.observe(menuRef.current);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.visualViewport?.removeEventListener('resize', updatePosition);
            observer?.disconnect();
        };
    }, [menu, offsetX]);

    return {
        ref: menuRef,
        style: position || (menu ? { left: menu.x + offsetX, top: menu.y } : undefined)
    };
};
