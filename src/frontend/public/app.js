// File Transfer Application - Main App
// This file contains the App component definition and initialization logic
console.log('Loading File Transfer App...');

// Main App Component Definition
const App = () => {
    const [user, setUser] = React.useState(null);
    const [authChecked, setAuthChecked] = React.useState(false);

    const handleLogin = (userData) => {
        setUser(userData);
    };

    const handleLogout = async () => {
        try {
            await fetch('/auth/logout', { method: 'POST' });
        } finally {
            setUser(null);
        }
    };

    // The browser sends the HttpOnly session cookie automatically.
    React.useEffect(() => {
        fetch('/auth/verify', { method: 'POST' })
            .then(response => {
                if (!response.ok) {
                    throw new Error('Token invalid');
                }
                return response.json();
            })
            .then(data => {
                setUser(data.user);
            })
            .catch(() => setUser(null))
            .finally(() => setAuthChecked(true));
    }, []);

    if (!authChecked) return null;
    if (!user) {
        return React.createElement(LoginForm, { onLogin: handleLogin });
    }

    return React.createElement(FileBrowser, { token: null, user: user, onLogout: handleLogout });
};

// Make App component available globally
if (!window.FileTransferApp) {
    window.FileTransferApp = {};
}
window.FileTransferApp.App = App;

// Add CSS animations
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
    ::placeholder {
        color: rgba(255, 255, 255, 0.6);
    }
`;
document.head.appendChild(style);

// Application initialization
const initializeApp = () => {
    console.log('Initializing File Transfer App...');
    
    const rootElement = document.getElementById('root');
    
    if (!rootElement) {
        console.error('Root element not found');
        return;
    }

    if (!window.React || !window.ReactDOM) {
        console.error('React dependencies not available');
        const loadingTextElement = document.getElementById('loading-text');
        if (loadingTextElement) {
            loadingTextElement.innerHTML = `
                <p style="color: #ef4444; margin: 0; font-size: 18px;">
                    React libraries not loaded
                </p>
            `;
        }
        return;
    }

    // Check if components are available
    if (typeof LoginForm === 'undefined') {
        console.error('LoginForm component not available');
        const loadingTextElement = document.getElementById('loading-text');
        if (loadingTextElement) {
            loadingTextElement.innerHTML = `
                <p style="color: #ef4444; margin: 0; font-size: 18px;">
                    LoginForm component not loaded
                </p>
            `;
        }
        return;
    }

    if (typeof FileBrowser === 'undefined') {
        console.error('FileBrowser component not available');
        const loadingTextElement = document.getElementById('loading-text');
        if (loadingTextElement) {
            loadingTextElement.innerHTML = `
                <p style="color: #ef4444; margin: 0; font-size: 18px;">
                    FileBrowser component not loaded
                </p>
            `;
        }
        return;
    }

    try {
        const appElement = React.createElement(App, {});
        // Use createRoot for React 18+ compatibility
        if (ReactDOM.createRoot) {
            const root = ReactDOM.createRoot(rootElement);
            root.render(appElement);
        } else {
            // Fallback for older React versions
            ReactDOM.render(appElement, rootElement);
        }
        console.log('✅ App initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing app:', error);
        const loadingTextElement = document.getElementById('loading-text');
        if (loadingTextElement) {
            loadingTextElement.textContent = `Error loading application: ${error.message}`;
            loadingTextElement.style.color = '#ef4444';
            loadingTextElement.style.margin = '0';
            loadingTextElement.style.fontSize = '18px';
        }
    }
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    // DOM is already loaded
    initializeApp();
}

console.log('App script loaded');
