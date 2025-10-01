// Import components
const { LoginForm } = typeof require !== 'undefined' ? require('./components/LoginForm') : {};
const { FileBrowser } = typeof require !== 'undefined' ? require('./components/FileBrowser') : {};

const App = () => {
    const [user, setUser] = React.useState(null);
    const [token, setToken] = React.useState('');

    const initializeAuth = async () => {
        const savedToken = localStorage.getItem('token');
        if (savedToken) {
            try {
                const response = await fetch('/auth/verify', {
                    headers: { 'Authorization': `Bearer ${savedToken}` }
                });
                
                if (response.ok) {
                    const userData = await response.json();
                    setUser(userData.user);
                    setToken(savedToken);
                } else {
                    localStorage.removeItem('token');
                }
            } catch (err) {
                localStorage.removeItem('token');
            }
        }
    };

    React.useEffect(() => {
        initializeAuth();
    }, []);

    const handleLogin = (userData, userToken) => {
        setUser(userData);
        setToken(userToken);
        localStorage.setItem('token', userToken);
    };

    const handleLogout = () => {
        setUser(null);
        setToken('');
        localStorage.removeItem('token');
    };

    if (user && token) {
        return React.createElement(FileBrowser, { 
            token: token, 
            user: user,
            onLogout: handleLogout
        });
    }

    return React.createElement(LoginForm, { onLogin: handleLogin });
};

// Export for use in HTML
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { App };
}

// For browser usage without module system
if (typeof window !== 'undefined') {
    window.FileTransferApp = { App };
}