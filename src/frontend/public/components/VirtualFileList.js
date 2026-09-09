import React from 'react';

export function virtualRange(count, columns, pitch, viewport, scroll, overscan = 4, gap = 0) {
    columns = Math.max(1, columns);
    const rows = Math.ceil(count / columns);
    const height = Math.max(0, rows * pitch - gap);
    const top = Math.max(0, Math.min(scroll, Math.max(0, height - viewport)));
    const first = Math.max(0, Math.floor(top / pitch) - overscan);
    const last = Math.min(rows, Math.ceil((top + viewport) / pitch) + overscan);
    return { first, last, rows, top, start: first * columns, end: Math.min(count, last * columns) };
}

export default function VirtualFileList({ items, mode, renderItem, onChoose, onOpen, onClear }) {
    const listRef = React.useRef(null);
    const [geometry, setGeometry] = React.useState({ columns: 1, size: mode === 'grid' ? 152 : 40, gap: 0, viewport: 0, scroll: 0, origin: 0 });
    const [focused, setFocused] = React.useState(null);
    const [dragged, setDragged] = React.useState(null);
    const keyFor = item => item.path || item.name;
    const focusIndex = items.findIndex(item => keyFor(item) === focused);
    const dragIndex = items.findIndex(item => keyFor(item) === dragged);
    const { columns, size, gap, viewport, scroll, origin } = geometry;
    const pitch = size + gap;
    const range = virtualRange(items.length, columns, pitch, viewport, scroll, 4, gap);
    const rows = new Set(Array.from({ length: range.last - range.first }, (_, i) => range.first + i));
    // Keep at most two extra logical rows so focus and native drag sources survive scrolling.
    if (focusIndex >= 0) rows.add(Math.floor(focusIndex / columns));
    if (dragIndex >= 0) rows.add(Math.floor(dragIndex / columns));

    React.useLayoutEffect(() => {
        const list = listRef.current;
        const area = list.parentElement;
        const measure = () => {
            const style = getComputedStyle(list);
            const item = list.querySelector('[data-file-index]');
            const header = mode === 'grid' ? 0 : list.querySelector('thead').getBoundingClientRect().height;
            const nextOrigin = list.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - area.clientTop + header;
            const next = {
                columns: mode === 'grid' ? Math.max(1, style.gridTemplateColumns.split(' ').length) : 1,
                size: item?.getBoundingClientRect().height || (mode === 'grid' ? 152 : 40),
                gap: mode === 'grid' ? parseFloat(style.rowGap) || 0 : 0,
                viewport: area.clientHeight,
                scroll: Math.max(0, area.scrollTop - nextOrigin), origin: nextOrigin
            };
            setGeometry(previous => Object.keys(next).every(key => Math.abs(previous[key] - next[key]) < 0.1) ? previous : next);
        };
        const observer = new ResizeObserver(measure);
        observer.observe(area);
        observer.observe(list);
        const first = list.querySelector('[data-file-index]');
        if (first) observer.observe(first);
        area.addEventListener('scroll', measure, { passive: true });
        measure();
        return () => { observer.disconnect(); area.removeEventListener('scroll', measure); };
    }, [mode, items]);

    const focusItem = index => {
        index = Math.max(0, Math.min(items.length - 1, index));
        if (index < 0) return;
        const area = listRef.current.parentElement;
        const top = origin + Math.floor(index / columns) * pitch;
        if (top < area.scrollTop) area.scrollTop = top;
        else if (top + size > area.scrollTop + area.clientHeight) area.scrollTop = top + size - area.clientHeight;
        setFocused(keyFor(items[index]));
    };
    React.useLayoutEffect(() => {
        if (focusIndex >= 0) listRef.current.querySelector(`[data-file-index="${focusIndex}"]`)?.focus({ preventScroll: true });
    }, [focused, mode]);

    const children = [];
    let previous = 0;
    const spacer = (start, length) => {
        if (length <= 0) return;
        const height = length * pitch - (mode === 'grid' ? gap : 0);
        children.push(mode === 'grid'
            ? <div key={`space-${start}`} aria-hidden="true" className="virtual-grid-spacer" style={{ height }} />
            : <tr key={`space-${start}`} aria-hidden="true" className="virtual-table-spacer"><td colSpan="4" style={{ height }} /></tr>);
    };
    [...rows].sort((a, b) => a - b).forEach(row => {
        spacer(previous, row - previous);
        for (let index = row * columns; index < Math.min(items.length, (row + 1) * columns); index++) {
            const item = items[index];
            children.push(React.cloneElement(renderItem(item), {
                'data-file-index': index, 'aria-rowindex': mode === 'grid' ? undefined : index + 2,
                'aria-posinset': mode === 'grid' ? index + 1 : undefined, 'aria-setsize': mode === 'grid' ? items.length : undefined,
                tabIndex: index === (focusIndex < 0 ? 0 : focusIndex) ? 0 : -1,
                onFocus: () => setFocused(keyFor(item))
            }));
        }
        previous = row + 1;
    });
    spacer(previous, range.rows - previous);
    const handlers = {
        onKeyDown: event => {
            const index = Number(event.target.closest('[data-file-index]')?.dataset.fileIndex);
            if (!Number.isInteger(index)) return;
            let next;
            if (event.key === 'ArrowDown') next = index + columns;
            if (event.key === 'ArrowUp') next = index - columns;
            if (event.key === 'ArrowRight') next = index + 1;
            if (event.key === 'ArrowLeft') next = index - 1;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = items.length - 1;
            if (event.key === 'PageDown') next = index + Math.max(1, Math.floor(viewport / pitch)) * columns;
            if (event.key === 'PageUp') next = index - Math.max(1, Math.floor(viewport / pitch)) * columns;
            if (next !== undefined) {
                event.preventDefault();
                next = Math.max(0, Math.min(items.length - 1, next));
                focusItem(next);
                if (event.shiftKey) onChoose(items[next], event);
            } else if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                if (event.key === 'Enter') onOpen(items[index]);
                else onChoose(items[index], event);
            }
        },
        onDragStartCapture: event => {
            const index = Number(event.target.closest('[data-file-index]')?.dataset.fileIndex);
            if (items[index]) setDragged(keyFor(items[index]));
        },
        onDragEndCapture: () => setDragged(null)
    };
    return mode === 'grid'
        ? <div ref={listRef} className="file-grid" role="list" {...handlers} onClick={event => { if (event.target === event.currentTarget || event.target.classList.contains('virtual-grid-spacer')) onClear(); }}>{children}</div>
        : <table ref={listRef} className="file-table" aria-rowcount={items.length + 1} {...handlers}><thead><tr><th>Name</th><th>Date modified</th><th>Type</th><th>Size</th></tr></thead><tbody>{children}</tbody></table>;
}
