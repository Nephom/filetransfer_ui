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
            const visibleViewport = window.visualViewport;
            const viewport = {
                left: visibleViewport?.offsetLeft || 0,
                top: visibleViewport?.offsetTop || 0,
                width: visibleViewport?.width || document.documentElement.clientWidth || window.innerWidth,
                height: visibleViewport?.height || document.documentElement.clientHeight || window.innerHeight
            };
            const edge = 8;
            const maxWidth = Math.max(1, viewport.width - edge * 2);
            const maxHeight = Math.max(1, viewport.height - edge * 2);
            const renderedWidth = Math.min(rectangle.width, maxWidth);
            const renderedHeight = Math.min(rectangle.height, maxHeight);
            const minLeft = viewport.left + edge;
            const minTop = viewport.top + edge;
            const maxLeft = Math.max(minLeft, viewport.left + viewport.width - renderedWidth - edge);
            const maxTop = Math.max(minTop, viewport.top + viewport.height - renderedHeight - edge);
            const left = Math.min(Math.max(minLeft, menu.x + offsetX), maxLeft);
            const top = Math.min(Math.max(minTop, menu.y), maxTop);
            setPosition({ left, top, maxWidth, maxHeight });
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        window.visualViewport?.addEventListener('resize', updatePosition);
        window.visualViewport?.addEventListener('scroll', updatePosition);
        const observer = window.ResizeObserver ? new ResizeObserver(updatePosition) : null;
        if (observer && menuRef.current) observer.observe(menuRef.current);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
            window.visualViewport?.removeEventListener('resize', updatePosition);
            window.visualViewport?.removeEventListener('scroll', updatePosition);
            observer?.disconnect();
        };
    }, [menu, offsetX]);

    return {
        ref: menuRef,
        style: position || (menu ? { left: menu.x + offsetX, top: menu.y } : undefined)
    };
};
