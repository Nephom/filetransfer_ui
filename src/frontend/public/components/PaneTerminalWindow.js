import React from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { usePaneMenuPosition } from './pane-workspace-utils.js';

const MAX_CLIPBOARD_BYTES = 64 * 1024;
const RECONNECT_DELAYS = [1000, 2000, 2000];

const authHeaders = token => token ? { Authorization: `Bearer ${token}` } : {};
const statusLabel = status => ({
    connected: 'Connected',
    connecting: 'Connecting...',
    reconnecting: 'Reconnecting...',
    disconnecting: 'Disconnecting...',
    disconnected: 'Disconnected',
    error: 'Error'
}[status] || 'Disconnected');

const emptyForm = { displayName: '', host: '', port: '22', username: '', authType: 'private-key', privateKey: '', password: '', passphrase: '' };

export default function PaneTerminalWindow({ window: pane, token, active, onFocus, onClose, onMinimize, onToggleMaximize, onMove, onTitlePointerDown: externalOnTitlePointerDown, onTitlePointerMove: externalOnTitlePointerMove, onTitlePointerUp: externalOnTitlePointerUp }) {
    const [targets, setTargets] = React.useState([]);
    const [targetId, setTargetId] = React.useState(pane.targetId || '');
    const [sshStatus, setSshStatus] = React.useState('disconnected');
    const [transportStatus, setTransportStatus] = React.useState('detached');
    const [error, setError] = React.useState('');
    const [viewportWidth, setViewportWidth] = React.useState(() => typeof window === 'undefined' ? 1024 : window.innerWidth);
    const [targetToolsOpen, setTargetToolsOpen] = React.useState(() => typeof window === 'undefined' || window.innerWidth > 900);
    const [clipboardToolsOpen, setClipboardToolsOpen] = React.useState(() => typeof window === 'undefined' || window.innerWidth > 900);
    const [targetLoading, setTargetLoading] = React.useState(true);
    const [formOpen, setFormOpen] = React.useState(false);
    const [editingId, setEditingId] = React.useState(null);
    const [form, setForm] = React.useState(emptyForm);
    const [menu, setMenu] = React.useState(null);
    const [menuThemeStyle, setMenuThemeStyle] = React.useState({});
    const [portalRoot, setPortalRoot] = React.useState(null);
    const [sidePanelCoordinates, setSidePanelCoordinates] = React.useState({
        target: { left: 8, top: 72, maxHeight: 'calc(100dvh - 80px)' },
        clipboard: { left: 8, top: 72, maxHeight: 'calc(100dvh - 80px)' }
    });
    const menuPosition = usePaneMenuPosition(menu);
    const terminalContainer = React.useRef(null);
    const terminalRef = React.useRef(null);
    const socketRef = React.useRef(null);
    const sessionIdRef = React.useRef(null);
    const reconnectTimerRef = React.useRef(null);
    const reconnectAttemptRef = React.useRef(0);
    const reconnectDeadlineRef = React.useRef(0);
    const intentionalRef = React.useRef(false);
    const mountedRef = React.useRef(true);
    const dragRef = React.useRef(null);
    const targetIdRef = React.useRef(targetId);
    const sshStatusRef = React.useRef(sshStatus);
    const sidePanelOriginRef = React.useRef(null);
    const onMoveRef = React.useRef(onMove);
    const compactToolbarLayout = viewportWidth <= 900 || pane.maximized;
    const overlayToolbarLayout = viewportWidth <= 600 || pane.maximized;
    targetIdRef.current = targetId;
    sshStatusRef.current = sshStatus;
    onMoveRef.current = onMove;

    const updateSidePanelPositions = React.useCallback(() => {
        const windowElement = terminalContainer.current?.closest('.pane-terminal-window');
        if (!windowElement) return;
        const rectangle = windowElement.getBoundingClientRect();
        const visible = window.visualViewport;
        const viewport = {
            left: visible?.offsetLeft || 0,
            top: visible?.offsetTop || 0,
            right: (visible?.offsetLeft || 0) + (visible?.width || document.documentElement.clientWidth || window.innerWidth),
            bottom: (visible?.offsetTop || 0) + (visible?.height || document.documentElement.clientHeight || window.innerHeight)
        };
        const edge = 8;
        const gap = 12;
        const panelWidth = overlayToolbarLayout ? 176 : 160;
        const minLeft = viewport.left + edge;
        const maxLeft = Math.max(minLeft, viewport.right - panelWidth - edge);
        const targetLeft = overlayToolbarLayout
            ? minLeft
            : Math.min(Math.max(minLeft, rectangle.left - panelWidth - gap), maxLeft);
        const clipboardLeft = overlayToolbarLayout
            ? maxLeft
            : Math.min(Math.max(minLeft, rectangle.right + gap), maxLeft);
        const minTop = viewport.top + edge;
        const maxTop = Math.max(minTop, viewport.bottom - 128);
        const top = Math.min(Math.max(minTop, rectangle.top + 44), maxTop);
        const maxHeight = Math.max(80, viewport.bottom - top - edge);
        setSidePanelCoordinates(current => {
            const next = {
                target: { left: Math.round(targetLeft), top: Math.round(top), maxHeight: `${Math.round(maxHeight)}px` },
                clipboard: { left: Math.round(clipboardLeft), top: Math.round(top), maxHeight: `${Math.round(maxHeight)}px` }
            };
            return current.target.left === next.target.left && current.target.top === next.target.top && current.target.maxHeight === next.target.maxHeight && current.clipboard.left === next.clipboard.left && current.clipboard.top === next.clipboard.top && current.clipboard.maxHeight === next.clipboard.maxHeight ? current : next;
        });
    }, [overlayToolbarLayout]);

    React.useLayoutEffect(() => {
        const windowElement = terminalContainer.current?.closest('.pane-terminal-window');
        if (!windowElement) return undefined;
        const observer = new ResizeObserver(updateSidePanelPositions);
        observer.observe(windowElement);
        observer.observe(terminalContainer.current);
        window.addEventListener('resize', updateSidePanelPositions);
        window.addEventListener('scroll', updateSidePanelPositions, true);
        window.visualViewport?.addEventListener('resize', updateSidePanelPositions);
        window.visualViewport?.addEventListener('scroll', updateSidePanelPositions);
        updateSidePanelPositions();
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', updateSidePanelPositions);
            window.removeEventListener('scroll', updateSidePanelPositions, true);
            window.visualViewport?.removeEventListener('resize', updateSidePanelPositions);
            window.visualViewport?.removeEventListener('scroll', updateSidePanelPositions);
        };
    }, [active, portalRoot, updateSidePanelPositions, pane.position?.left, pane.position?.top]);

    React.useEffect(() => {
        const updateViewportWidth = () => setViewportWidth(window.innerWidth);
        window.addEventListener('resize', updateViewportWidth);
        return () => window.removeEventListener('resize', updateViewportWidth);
    }, []);
    React.useLayoutEffect(() => {
        const root = terminalContainer.current?.closest('.pane-explorer');
        if (root) setPortalRoot(root);
    }, []);
    const selectedTarget = targets.find(target => target.id === targetId) || null;
    const setStatus = (status, transport = transportStatus) => {
        if (!mountedRef.current) return;
        setSshStatus(status);
        setTransportStatus(transport);
    };
    const writeLine = message => terminalRef.current?.writeln(`\r\n[${message}]`);
    const fetchTargets = React.useCallback(async () => {
        setTargetLoading(true);
        try {
            const response = await fetch('/api/terminal/targets', { headers: authHeaders(token) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Unable to load SSH targets.');
            if (mountedRef.current) {
                setTargets(data.targets || []);
                setTargetId(current => current && (data.targets || []).some(target => target.id === current) ? current : (data.targets || [])[0]?.id || '');
            }
        } catch (requestError) {
            if (mountedRef.current) setError(requestError.message);
        } finally {
            if (mountedRef.current) setTargetLoading(false);
        }
    }, [token]);

    const sendResize = React.useCallback(() => {
        const socket = socketRef.current;
        const terminal = terminalRef.current;
        if (socket?.readyState !== WebSocket.OPEN || !terminal) return;
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    }, []);

    const fitTerminal = React.useCallback(() => {
        const terminal = terminalRef.current;
        if (!terminal || !terminalContainer.current) {
            console.log('[Terminal] fitTerminal skipped - terminal:', !!terminal, 'container:', !!terminalContainer.current);
            return;
        }
        try {
            const windowElement = terminalContainer.current.closest('.pane-window');
            const computed = windowElement ? Number.parseFloat(getComputedStyle(windowElement).fontSize) : 14;
            const fontSize = Number.isFinite(computed) ? Math.max(11, Math.min(22, computed)) : 14;
            terminal.options.fontSize = fontSize;
            const rectangle = terminalContainer.current.getBoundingClientRect();
            console.log('[Terminal] fitTerminal - container rect:', rectangle.width, 'x', rectangle.height, 'fontSize:', fontSize);
            const characterWidth = Math.max(6, fontSize * 0.6);
            const lineHeight = Math.max(13, fontSize * 1.2);
            const cols = Math.max(20, Math.floor(rectangle.width / characterWidth));
            const rows = Math.max(4, Math.floor(rectangle.height / lineHeight));
            console.log('[Terminal] fitTerminal - calculated cols:', cols, 'rows:', rows);
            terminal.resize(cols, rows);
            console.log('[Terminal] fitTerminal - actual terminal size after resize:', terminal.cols, 'x', terminal.rows);
            sendResize();
        } catch (e) {
            console.log('[Terminal] fitTerminal error:', e);
        }
    }, [sendResize]);

    const clearReconnect = React.useCallback(() => {
        if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
    }, []);

    const openSocket = React.useCallback((ticket, sessionId) => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${window.location.host}/ws/terminal/${encodeURIComponent(sessionId)}?ticket=${encodeURIComponent(ticket)}`);
        socket.binaryType = 'arraybuffer';
        socketRef.current = socket;
        socket.onopen = () => {
            console.log('[Terminal] WebSocket onopen');
            if (!mountedRef.current) return socket.close();
            reconnectAttemptRef.current = 0;
            setStatus('connected', 'attached');
            console.log('[Terminal] WebSocket opened, calling fitTerminal()');
            fitTerminal();
            console.log('[Terminal] WebSocket calling focus()');
            terminalRef.current?.focus();
        };
        socket.onmessage = async event => {
            if (!mountedRef.current) return;
            if (typeof event.data === 'string') {
                try {
                    const control = JSON.parse(event.data);
                    if (control.type === 'status') {
                        console.log('[Terminal] WebSocket status message:', control);
                        setError(control.error || '');
                        if (control.hostKeyUpdated) writeLine('Remote host key updated and recorded.');
                        setStatus(control.sshStatus || control.status || 'connected', control.transportStatus || 'attached');
                        if (['disconnected', 'error'].includes(control.sshStatus || control.status)) {
                            sessionIdRef.current = null;
                            reconnectDeadlineRef.current = 0;
                            setTransportStatus('detached');
                        }
                        return;
                    }
                } catch { /* SSH output can be text that is not JSON. */ }
                console.log('[Terminal] Writing string data to terminal, length:', event.data.length);
                terminalRef.current?.write(event.data);
                return;
            }
            if (event.data instanceof Blob) {
                const arrayBuffer = await event.data.arrayBuffer();
                console.log('[Terminal] Writing Blob data to terminal, size:', arrayBuffer.byteLength, 'first bytes:', new Uint8Array(arrayBuffer).slice(0, 50));
                terminalRef.current?.write(new Uint8Array(arrayBuffer));
            } else if (event.data instanceof ArrayBuffer) {
                console.log('[Terminal] Writing ArrayBuffer data to terminal, size:', event.data.byteLength, 'first bytes:', new Uint8Array(event.data).slice(0, 50));
                terminalRef.current?.write(new Uint8Array(event.data));
            } else {
                const dataStr = typeof event.data === 'string' ? event.data : String(event.data);
                console.log('[Terminal] Writing raw data to terminal, length:', dataStr.length, 'preview:', dataStr.substring(0, 100));
                terminalRef.current?.write(event.data);
            }
        };
        socket.onerror = (error) => {
            console.log('[Terminal] WebSocket error:', error);
        };
        socket.onclose = (event) => {
            console.log('[Terminal] WebSocket onclose:', event.code, event.reason);
            if (socketRef.current === socket) socketRef.current = null;
            if (!mountedRef.current || intentionalRef.current || !sessionIdRef.current) return;
            setStatus('reconnecting', 'detached');
            scheduleReconnect();
        };
    }, [fitTerminal]);

    const attachExisting = React.useCallback(async sessionId => {
        const response = await fetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/attach`, { method: 'POST', headers: authHeaders(token) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(data.error || 'Terminal session is no longer available.'), { status: response.status });
        openSocket(data.session.attachTicket, data.session.sessionId);
    }, [openSocket, token]);

    const scheduleReconnect = React.useCallback(() => {
        clearReconnect();
        const attempt = reconnectAttemptRef.current;
        const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(async () => {
            const sessionId = sessionIdRef.current;
            if (!sessionId || intentionalRef.current || !mountedRef.current) return;
            try {
                const statusResponse = await fetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`, { headers: authHeaders(token) });
                const statusData = await statusResponse.json().catch(() => ({}));
                const session = statusData.session;
                if (!statusResponse.ok || !session || session.sshStatus !== 'reconnecting' || Number(session.reconnectDeadline) <= Date.now()) {
                    sessionIdRef.current = null;
                    reconnectDeadlineRef.current = 0;
                    setStatus('disconnected', 'detached');
                    return;
                }
                reconnectDeadlineRef.current = Number(session.reconnectDeadline);
                await attachExisting(sessionId);
            } catch (requestError) {
                if (requestError.status === 404 || requestError.status === 409 || !sessionIdRef.current) {
                    sessionIdRef.current = null;
                    reconnectDeadlineRef.current = 0;
                    setStatus('disconnected', 'detached');
                    return;
                }
                if (Date.now() < reconnectDeadlineRef.current) scheduleReconnect();
                else {
                    sessionIdRef.current = null;
                    reconnectDeadlineRef.current = 0;
                    setStatus('disconnected', 'detached');
                }
            }
        }, delay);
    }, [attachExisting, clearReconnect, token]);

    const connectNew = React.useCallback(async () => {
        console.log('[Terminal] connectNew called, targetId:', targetIdRef.current);
        const terminal = terminalRef.current;
        console.log('[Terminal] Terminal instance:', !!terminal, 'cols:', terminal?.cols, 'rows:', terminal?.rows);
        if (!targetIdRef.current) throw new Error('Select an SSH target first.');
        const response = await fetch('/api/terminal/sessions', {
            method: 'POST',
            headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetId: targetIdRef.current, cols: terminal?.cols || 120, rows: terminal?.rows || 32 })
        });
        const data = await response.json().catch(() => ({}));
        console.log('[Terminal] connectNew response:', data);
        if (!response.ok) throw new Error(data.error || 'Unable to connect to the SSH target.');
        sessionIdRef.current = data.session.sessionId;
        reconnectDeadlineRef.current = 0;
        setError('');
        setStatus(data.session.sshStatus, 'detached');
        console.log('[Terminal] Opening WebSocket with sessionId:', data.session.sessionId);
        openSocket(data.session.attachTicket, data.session.sessionId);
    }, [openSocket, token]);

    const connect = React.useCallback(async () => {
        if (['connecting', 'disconnecting', 'connected', 'reconnecting'].includes(sshStatusRef.current)) return;
        intentionalRef.current = false;
        clearReconnect();
        setStatus('connecting', 'detached');
        setError('');
        try {
            if (sessionIdRef.current) await attachExisting(sessionIdRef.current);
            else await connectNew();
        } catch (requestError) {
            sessionIdRef.current = null;
            setStatus('error', 'detached');
            setError(requestError.message);
        }
    }, [attachExisting, clearReconnect, connectNew]);

    const disconnect = React.useCallback(async () => {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return setStatus('disconnected', 'detached');
        intentionalRef.current = true;
        clearReconnect();
        setStatus('disconnecting', 'detached');
        sessionIdRef.current = null;
        const socket = socketRef.current;
        socketRef.current = null;
        try { socket?.close(1000, 'User disconnected'); } catch { /* Socket may already be closed. */ }
        try {
            await fetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/disconnect`, { method: 'POST', headers: authHeaders(token), keepalive: true });
        } finally {
            if (mountedRef.current) setStatus('disconnected', 'detached');
        }
    }, [clearReconnect, token]);

    const copySelection = React.useCallback(async () => {
        const selected = terminalRef.current?.getSelection() || '';
        if (!selected) return;
        try { await navigator.clipboard.writeText(selected); terminalRef.current?.focus(); }
        catch { setError('Clipboard access is unavailable.'); }
    }, []);

    const pasteText = React.useCallback(async text => {
        if (new TextEncoder().encode(text).length > MAX_CLIPBOARD_BYTES) return setError('Clipboard content is too large.');
        if (sshStatusRef.current !== 'connected') return setError('Connect the terminal before pasting.');
        terminalRef.current?.paste(text);
        terminalRef.current?.focus();
    }, []);
    const pasteClipboard = React.useCallback(async () => {
        try { await pasteText(await navigator.clipboard.readText()); }
        catch { setError('Clipboard access is unavailable.'); }
    }, [pasteText]);
    const pasteSelected = React.useCallback(() => pasteText(terminalRef.current?.getSelection() || ''), [pasteText]);

    const openNewTarget = () => { setEditingId(null); setForm({ ...emptyForm }); setFormOpen(true); setMenu(null); };
    const openEditTarget = () => {
        if (!selectedTarget) return;
        setEditingId(selectedTarget.id);
        setForm({ displayName: selectedTarget.displayName, host: selectedTarget.host, port: String(selectedTarget.port), username: selectedTarget.username, authType: selectedTarget.authType, privateKey: '', password: '', passphrase: '' });
        setFormOpen(true);
        setMenu(null);
    };
    const saveTarget = async event => {
        event.preventDefault();
        const payload = { displayName: form.displayName, host: form.host, port: Number(form.port), username: form.username, authType: form.authType };
        if (form.authType === 'private-key') {
            if (form.privateKey) payload.privateKey = form.privateKey;
            if (form.passphrase) payload.passphrase = form.passphrase;
        } else if (form.authType === 'password') {
            if (form.password) payload.password = form.password;
        }
        try {
            const response = await fetch(editingId ? `/api/terminal/targets/${encodeURIComponent(editingId)}` : '/api/terminal/targets', { method: editingId ? 'PUT' : 'POST', headers: { ...authHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const errorMessage = data.error || 'Unable to save SSH target.';
                if (errorMessage.includes('encryption key') || errorMessage.includes('SSH_TARGET_ENCRYPTION_KEY')) {
                    setError('Server configuration error: SSH encryption key is not configured. Please contact your administrator to set the SSH_TARGET_ENCRYPTION_KEY environment variable.');
                } else if (errorMessage.includes('private key is required')) {
                    setError('Private key is required for private-key authentication. Please enter your private key content.');
                } else if (errorMessage.includes('password is required')) {
                    setError('Password is required for password authentication. Please enter your password.');
                } else {
                    setError(errorMessage);
                }
                return;
            }
            await fetchTargets();
            if (data.target?.id) setTargetId(data.target.id);
            setFormOpen(false);
            setError('');
        } catch (requestError) { setError(requestError.message); }
    };
    const deleteTarget = async () => {
        if (!selectedTarget || !window.confirm(`Delete SSH target ${selectedTarget.displayName}?`)) return;
        try {
            if (sessionIdRef.current) await disconnect();
            const response = await fetch(`/api/terminal/targets/${encodeURIComponent(selectedTarget.id)}`, { method: 'DELETE', headers: authHeaders(token) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Unable to delete SSH target.');
            setTargetId('');
            await fetchTargets();
        } catch (requestError) { setError(requestError.message); }
    };
    const testTarget = async () => {
        if (!selectedTarget) return;
        try {
            setError('Testing SSH connection...');
            const response = await fetch(`/api/terminal/targets/${encodeURIComponent(selectedTarget.id)}/test`, { method: 'POST', headers: authHeaders(token) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'SSH connection test failed.');
            setError(data.hostKeyFingerprint ? `Connection succeeded. Host key ${data.hostKeyFingerprint}` : 'Connection succeeded.');
            await fetchTargets();
        } catch (requestError) { setError(requestError.message); }
    };

    const chooseTarget = async event => {
        const nextId = event.target.value;
        if (nextId === targetId) return;
        if (sessionIdRef.current) await disconnect();
        setTargetId(nextId);
        setError('');
    };

    const onTitlePointerDown = event => {
        if (event.target.closest('button, select, input, textarea')) return;
        const windowElement = event.currentTarget.closest('.pane-window');
        const layer = windowElement?.parentElement;
        if (!windowElement || !layer || dragRef.current) return;
        event.preventDefault();
        onFocus(pane.id);
        const windowRect = windowElement.getBoundingClientRect();
        const layerRect = layer.getBoundingClientRect();
        dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - windowRect.left, offsetY: event.clientY - windowRect.top, layerRect };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onTitlePointerMove = event => {
        const drag = dragRef.current;
        const windowElement = event.currentTarget.closest('.pane-window');
        if (!drag || drag.pointerId !== event.pointerId || !windowElement) return;
        onMove(pane.id, Math.max(0, Math.min(drag.layerRect.width - windowElement.offsetWidth, event.clientX - drag.layerRect.left - drag.offsetX)), Math.max(0, Math.min(drag.layerRect.height - windowElement.offsetHeight, event.clientY - drag.layerRect.top - drag.offsetY)));
    };
    const onTitlePointerUp = event => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        dragRef.current = null;
    };

    const prepareCompactDeck = side => {
        if (!compactToolbarLayout || overlayToolbarLayout || sidePanelOriginRef.current) return;
        const windowElement = terminalContainer.current?.closest('.pane-window');
        const layer = windowElement?.parentElement;
        if (!windowElement || !layer) return;
        const rectangle = windowElement.getBoundingClientRect();
        const layerRectangle = layer.getBoundingClientRect();
        sidePanelOriginRef.current = {
            explicit: !!pane.position,
            left: pane.position?.left ?? rectangle.left - layerRectangle.left,
            top: pane.position?.top ?? rectangle.top - layerRectangle.top
        };
        onMoveRef.current?.(pane.id, side === 'left' ? 172 : 8, sidePanelOriginRef.current.top);
    };
    const restoreCompactDeck = React.useCallback(() => {
        const origin = sidePanelOriginRef.current;
        if (!origin) return;
        onMoveRef.current?.(pane.id, origin.explicit ? origin.left : null, origin.explicit ? origin.top : null);
        sidePanelOriginRef.current = null;
    }, [pane.id]);
    const positionCompactDeckForSide = side => {
        if (!compactToolbarLayout || overlayToolbarLayout) return;
        if (!sidePanelOriginRef.current) {
            prepareCompactDeck(side);
            return;
        }
        onMoveRef.current?.(pane.id, side === 'left' ? 172 : 8, sidePanelOriginRef.current.top);
    };
    const toggleTargetTools = () => {
        if (compactToolbarLayout) {
            if (targetToolsOpen) {
                setTargetToolsOpen(false);
                setClipboardToolsOpen(false);
                restoreCompactDeck();
                return;
            }
            positionCompactDeckForSide('left');
            setClipboardToolsOpen(false);
        }
        setTargetToolsOpen(open => !open);
    };
    const toggleClipboardTools = () => {
        if (compactToolbarLayout) {
            if (clipboardToolsOpen) {
                setClipboardToolsOpen(false);
                setTargetToolsOpen(false);
                restoreCompactDeck();
                return;
            }
            positionCompactDeckForSide('right');
            setTargetToolsOpen(false);
        }
        setClipboardToolsOpen(open => !open);
    };
    const renderSideToggle = (side, expanded, controlsId, onToggle) => <button
        type="button"
        className={`pane-terminal-side-toggle is-${side}`}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${side === 'left' ? 'SSH target controls' : 'terminal clipboard controls'}`}
        aria-expanded={expanded}
        aria-controls={controlsId}
        onClick={onToggle}
    >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={side === 'left' ? (expanded ? 'm14 5-7 7 7 7' : 'm10 5 7 7-7 7') : (expanded ? 'm10 5 7 7-7 7' : 'm14 5-7 7 7 7')} />
            <path d={side === 'left' ? 'M20 4v16' : 'M4 4v16'} />
        </svg>
    </button>;

    React.useEffect(() => {
        restoreCompactDeck();
        if (compactToolbarLayout || overlayToolbarLayout) {
            setTargetToolsOpen(false);
            setClipboardToolsOpen(false);
        } else {
            setTargetToolsOpen(true);
            setClipboardToolsOpen(true);
        }
    }, [compactToolbarLayout, overlayToolbarLayout, restoreCompactDeck]);

    React.useEffect(() => { void fetchTargets(); }, [fetchTargets]);
    React.useLayoutEffect(() => {
        if (!menu) {
            setMenuThemeStyle({});
            return;
        }
        const themeRoot = terminalContainer.current?.closest('.pane-explorer');
        if (!themeRoot) return;
        const theme = window.getComputedStyle(themeRoot);
        const controlFontSize = theme.getPropertyValue('--pane-control-font-size').trim();
        setMenuThemeStyle({
            '--pane-accent': theme.getPropertyValue('--pane-accent').trim(),
            '--pane-line-strong': theme.getPropertyValue('--pane-line-strong').trim(),
            '--pane-text': theme.getPropertyValue('--pane-text').trim(),
            '--pane-menu-background': theme.getPropertyValue('--pane-menu-background').trim(),
            '--pane-small-font-size': controlFontSize || theme.getPropertyValue('--pane-small-font-size').trim()
        });
    }, [menu]);
    React.useEffect(() => {
        const closeMenu = (event) => {
            if (event.target.closest?.('.pane-context-menu')) return;
            setMenu(null);
        };
        window.addEventListener('click', closeMenu);
        return () => window.removeEventListener('click', closeMenu);
    }, []);
    React.useEffect(() => {
        mountedRef.current = true;
        console.log('[Terminal] Creating Terminal instance, terminalContainer.current:', terminalContainer.current);
        const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 14, theme: { background: '#050d18', foreground: '#d9eafa', cursor: '#5cdbff', selectionBackground: 'rgba(92,219,255,.35)' }, scrollback: 5000 });
        console.log('[Terminal] Terminal instance created');
        terminal.open(terminalContainer.current);
        console.log('[Terminal] Terminal opened in container');
        terminalRef.current = terminal;
        const dataSubscription = terminal.onData(data => { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(data); });
        terminal.attachCustomKeyEventHandler(event => {
            if (!(event.ctrlKey || event.metaKey)) return true;
            if (event.key.toLowerCase() === 'c' && terminal.hasSelection()) { void copySelection(); return false; }
            if (event.key.toLowerCase() === 'v') { void pasteClipboard(); return false; }
            return true;
        });
        const observer = new ResizeObserver(fitTerminal);
        observer.observe(terminalContainer.current);
        console.log('[Terminal] ResizeObserver set up');
        window.requestAnimationFrame(fitTerminal);
        return () => {
            console.log('[Terminal] Cleanup called');
            mountedRef.current = false;
            intentionalRef.current = true;
            clearReconnect();
            const sessionId = sessionIdRef.current;
            if (sessionId) void fetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/disconnect`, { method: 'POST', headers: authHeaders(token), keepalive: true });
            try { socketRef.current?.close(1000, 'Pane closed'); } catch { /* Socket may already be closed. */ }
            observer.disconnect();
            dataSubscription.dispose();
            terminal.dispose();
            terminalRef.current = null;
        };
    }, [clearReconnect, copySelection, fitTerminal, pasteClipboard, token]);

    const contextMenuPortal = menu && typeof document !== 'undefined' && document.body
        ? createPortal(<div ref={menuPosition.ref} className="pane-context-menu pane-terminal-context-menu" style={{ ...menuPosition.style, ...menuThemeStyle, zIndex: 10000 }} onClick={event => event.stopPropagation()}><button type="button" onClick={() => { setMenu(null); void copySelection(); }}>Copy</button><button type="button" onClick={() => { setMenu(null); void pasteClipboard(); }}>Paste</button><button type="button" onClick={() => { setMenu(null); pasteSelected(); }}>Paste selected</button><button type="button" onClick={() => { setMenu(null); terminalRef.current?.selectAll(); terminalRef.current?.focus(); }}>Select all</button></div>, document.body)
        : null;
    const terminalSidePanelsPortal = active && portalRoot && typeof document !== 'undefined'
        ? createPortal(<div className="pane-terminal-side-dock-layer" style={{ zIndex: 60 }}>
            <aside className={`pane-terminal-side-panel pane-terminal-target-panel ${targetToolsOpen ? 'is-expanded' : 'is-collapsed'}`} aria-label="SSH target controls" style={{ ...sidePanelCoordinates.target, left: `${sidePanelCoordinates.target.left + (targetToolsOpen ? 0 : (overlayToolbarLayout ? 176 : 160) - 28)}px`, width: `${targetToolsOpen ? (overlayToolbarLayout ? 176 : 160) : 28}px` }}>
                {renderSideToggle('left', targetToolsOpen, `pane-target-controls-${pane.id}`, toggleTargetTools)}
                <div className="pane-terminal-side-content" id={`pane-target-controls-${pane.id}`} hidden={!targetToolsOpen}>
                    <div className="pane-terminal-side-heading">SSH TARGET</div>
                    <div className="pane-terminal-toolbar"><label>Target<select value={targetId} onChange={chooseTarget} disabled={targetLoading || ['connecting', 'connected', 'reconnecting', 'disconnecting'].includes(sshStatus)}><option value="">Select target</option>{targets.map(target => <option value={target.id} key={target.id}>{target.displayName} ({target.username}@{target.host}:{target.port})</option>)}</select></label><button type="button" onClick={openNewTarget}>New target</button><button type="button" onClick={openEditTarget} disabled={!selectedTarget}>Edit</button><button type="button" onClick={() => void deleteTarget()} disabled={!selectedTarget}>Delete</button><button type="button" onClick={() => void testTarget()} disabled={!selectedTarget || ['connecting', 'connected', 'reconnecting', 'disconnecting'].includes(sshStatus)}>Test</button></div>
                </div>
            </aside>
            <aside className={`pane-terminal-side-panel pane-terminal-clipboard-panel ${clipboardToolsOpen ? 'is-expanded' : 'is-collapsed'}`} aria-label="Terminal clipboard controls" style={{ ...sidePanelCoordinates.clipboard, width: `${clipboardToolsOpen ? (overlayToolbarLayout ? 176 : 160) : 28}px` }}>
                {renderSideToggle('right', clipboardToolsOpen, `pane-clipboard-controls-${pane.id}`, toggleClipboardTools)}
                <div className="pane-terminal-side-content" id={`pane-clipboard-controls-${pane.id}`} hidden={!clipboardToolsOpen}>
                    <div className="pane-terminal-side-heading">CLIPBOARD</div>
                    <div className="pane-terminal-clipboard"><button type="button" onClick={() => void copySelection()}>Copy</button><button type="button" onClick={() => void pasteClipboard()}>Paste</button><button type="button" onClick={pasteSelected}>Paste selected</button><button type="button" onClick={() => { terminalRef.current?.selectAll(); terminalRef.current?.focus(); }}>Select all</button><span className={`pane-terminal-transport ${transportStatus}`}>{statusLabel(sshStatus)}</span></div>
                </div>
            </aside>
        </div>, portalRoot)
        : null;

    return <>
        <article data-window-id={pane.id} className={`pane-window pane-terminal-window ${active ? 'is-active' : ''} ${pane.minimized ? 'is-minimized' : ''} ${pane.maximized ? 'is-maximized' : ''}`} style={{ zIndex: pane.z, ...(pane.position ? { left: `${pane.position.left}px`, top: `${pane.position.top}px` } : {}) }} onPointerDown={() => onFocus(pane.id)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }); }}>
        <header className="pane-window-titlebar" onPointerDown={externalOnTitlePointerDown || onTitlePointerDown} onPointerMove={externalOnTitlePointerMove || onTitlePointerMove} onPointerUp={externalOnTitlePointerUp || onTitlePointerUp}>
            <div><span className="terminal-icon" aria-hidden="true">&gt;_</span><strong>{selectedTarget?.displayName || 'SSH Terminal'}</strong><small>{statusLabel(sshStatus)}{selectedTarget ? ` · ${selectedTarget.host}` : ''}</small></div>
            <span className="pane-window-controls"><button type="button" className="pane-terminal-connect" onClick={() => ['connected', 'reconnecting'].includes(sshStatus) ? void disconnect() : void connect()} disabled={['connecting', 'disconnecting'].includes(sshStatus)}>{['connected', 'reconnecting'].includes(sshStatus) ? 'Disconnect' : 'Connect'}</button><button type="button" className="pane-window-minimize" onClick={() => onMinimize(pane.id)} aria-label="Minimize window" title="Minimize window">-</button><button type="button" className="pane-window-maximize" onClick={() => onToggleMaximize(pane.id)} aria-label={pane.maximized ? 'Restore window' : 'Maximize window'} title={pane.maximized ? 'Restore window' : 'Maximize window'}>{pane.maximized ? 'x' : '[]'}</button><button type="button" className="pane-window-close" onClick={() => onClose(pane.id)} aria-label="Close terminal window" title="Close terminal window">x</button></span>
        </header>
        {formOpen && <div className="pane-terminal-form-overlay" onClick={() => setFormOpen(false)}><div className="pane-terminal-form-modal" onClick={event => event.stopPropagation()}><form className="pane-terminal-target-form" onSubmit={saveTarget}><div className="pane-terminal-form-heading"><strong>{editingId ? 'Edit SSH target' : 'New SSH target'}</strong><button type="button" onClick={() => setFormOpen(false)} aria-label="Close target form">x</button></div><label>Name<input required value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} /></label><label>Host<input required value={form.host} onChange={event => setForm(current => ({ ...current, host: event.target.value }))} /></label><div className="pane-terminal-form-row"><label>Port<input required type="number" min="1" max="65535" value={form.port} onChange={event => setForm(current => ({ ...current, port: event.target.value }))} /></label><label>Username<input required value={form.username} onChange={event => setForm(current => ({ ...current, username: event.target.value }))} /></label></div><label>Authentication<select value={form.authType} onChange={event => setForm(current => ({ ...current, authType: event.target.value }))}><option value="private-key">Private key</option><option value="password">Password</option></select></label>{form.authType === 'private-key' ? <><label>Private key{editingId && <small>Leave empty to keep the saved key.</small>}<textarea required={!editingId} value={form.privateKey} onChange={event => setForm(current => ({ ...current, privateKey: event.target.value }))} /></label><label>Passphrase<input type="password" value={form.passphrase} onChange={event => setForm(current => ({ ...current, passphrase: event.target.value }))} /></label></> : <label>Password{editingId && <small>Leave empty to keep the saved password.</small>}<input required={!editingId} type="password" value={form.password} onChange={event => setForm(current => ({ ...current, password: event.target.value }))} /></label>}<div className="pane-terminal-form-actions"><button type="button" onClick={() => setFormOpen(false)}>Cancel</button><button type="button" className="confirm" onClick={saveTarget}>{editingId ? 'Save' : 'Create'}</button></div></form></div></div>}
        {error && <div className="pane-error" role="alert">{error}</div>}
        <div className="pane-terminal-output" ref={terminalContainer} />
         {contextMenuPortal}
        </article>
        {terminalSidePanelsPortal}
    </>;
}
