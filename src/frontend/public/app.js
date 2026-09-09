import React from 'react';
import { createRoot } from 'react-dom/client';
import LoginForm from './components/LoginForm.js';
import FileBrowser from './components/FileBrowser.js';

const App = () => {
    const [user, setUser] = React.useState(null);
    const [authChecked, setAuthChecked] = React.useState(false);
    const handleLogout = async () => {
        // Unmount transfers before the cookie can belong to another session.
        setUser(null);
        setAuthChecked(false);
        try { await fetch('/auth/logout', { method: 'POST' }); }
        catch { /* A new login is still possible after a network failure. */ }
        finally { setAuthChecked(true); }
    };
    React.useEffect(() => {
        const controller = new AbortController();
        fetch('/auth/verify', { method: 'POST', signal: controller.signal })
            .then(response => {
                if (!response.ok) throw new Error('Session invalid');
                return response.json();
            })
            .then(data => { if (!controller.signal.aborted) setUser(data.user); })
            .catch(() => { if (!controller.signal.aborted) setUser(null); })
            .finally(() => { if (!controller.signal.aborted) setAuthChecked(true); });
        return () => controller.abort();
    }, []);
    if (!authChecked) return null;
    if (!user) return <LoginForm onLogin={setUser} />;
    return <FileBrowser key={user.id || user.username} token={null} user={user} onLogout={handleLogout} />;
};

const style = document.createElement('style');
style.textContent = `
    @keyframes pulse {
        0%, 100% { opacity: 0.3; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(1.05); }
    }
    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
    ::placeholder { color: rgba(255, 255, 255, 0.6); }
`;
document.head.appendChild(style);
createRoot(document.getElementById('root')).render(<App />);
