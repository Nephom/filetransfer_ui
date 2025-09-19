const { useState, useEffect } = React;

// Authentication Component
const LoginForm = ({ onLogin }) => {
    const [credentials, setCredentials] = useState({ username: '', password: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const response = await fetch('/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(credentials)
            });

            const data = await response.json();
            
            if (response.ok) {
                localStorage.setItem('token', data.token);
                onLogin(data.user, data.token);
            } else {
                setError(data.error || 'Login failed');
            }
        } catch (err) {
            setError('Connection error');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center">
            <div className="glass-effect rounded-lg p-8 w-full max-w-md fade-in">
                <h2 className="text-2xl font-bold text-center mb-6 text-blue-400">
                    🚀 File Transfer UI
                </h2>
                
                {error && (
                    <div className="bg-red-500 bg-opacity-20 border border-red-500 text-red-200 px-4 py-2 rounded mb-4">
                        {error}
                    </div>
                )}
                
                <form onSubmit={handleSubmit}>
                    <div className="mb-4">
                        <label className="block text-sm font-medium mb-2">Username</label>
                        <input
                            type="text"
                            value={credentials.username}
                            onChange={(e) => setCredentials({...credentials, username: e.target.value})}
                            className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded focus:outline-none focus:border-blue-500"
                            required
                        />
                    </div>
                    
                    <div className="mb-6">
                        <label className="block text-sm font-medium mb-2">Password</label>
                        <input
                            type="password"
                            value={credentials.password}
                            onChange={(e) => setCredentials({...credentials, password: e.target.value})}
                            className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded focus:outline-none focus:border-blue-500"
                            required
                        />
                    </div>
                    
                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-2 px-4 rounded neon-glow transition-all"
                    >
                        {loading ? 'Logging in...' : 'Login'}
                    </button>
                </form>
                
                <div className="mt-4 text-center text-sm text-gray-400">
                    Default: admin / password
                </div>
            </div>
        </div>
    );
};

// File Browser Component
const FileBrowser = ({ token, user }) => {
    const [files, setFiles] = useState([]);
    const [currentPath, setCurrentPath] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [selectedItems, setSelectedItems] = useState([]);
    const [showContextMenu, setShowContextMenu] = useState(false);
    const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
    const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [uploading, setUploading] = useState(false);

    const fetchFiles = async (path = '') => {
        setLoading(true);
        setError('');
        try {
            const apiPath = path ? `/api/files/${path}` : '/api/files';
            console.log('Fetching files from:', apiPath);

            const response = await fetch(apiPath, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (response.ok) {
                const data = await response.json();
                console.log('Files received:', data);
                setFiles(data);
                setCurrentPath(path);
            } else {
                const errorData = await response.json();
                setError(errorData.error || 'Failed to load files');
            }
        } catch (err) {
            console.error('Fetch error:', err);
            setError('Connection error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchFiles(currentPath);
    }, [token]);

    const handleLogout = () => {
        localStorage.removeItem('token');
        window.location.reload();
    };

    const handleItemClick = (item) => {
        if (item.name.includes('.')) {
            // It's a file - could implement file preview/download here
            console.log('File clicked:', item.name);
        } else {
            // It's a directory - navigate into it
            const newPath = currentPath ? `${currentPath}/${item.name}` : item.name;
            fetchFiles(newPath);
        }
    };

    const handleBackClick = () => {
        if (currentPath) {
            const pathParts = currentPath.split('/');
            pathParts.pop();
            const newPath = pathParts.join('/');
            fetchFiles(newPath);
        }
    };

    const getBreadcrumbs = () => {
        if (!currentPath) return [{ name: 'Storage', path: '' }];

        const parts = currentPath.split('/');
        const breadcrumbs = [{ name: 'Storage', path: '' }];

        let currentBreadcrumbPath = '';
        parts.forEach(part => {
            currentBreadcrumbPath = currentBreadcrumbPath ? `${currentBreadcrumbPath}/${part}` : part;
            breadcrumbs.push({ name: part, path: currentBreadcrumbPath });
        });

        return breadcrumbs;
    };

    const getFileIcon = (item) => {
        if (!item.name.includes('.')) {
            // Directory
            return '📁';
        }

        // File - determine type by extension
        const ext = item.name.split('.').pop().toLowerCase();
        switch (ext) {
            case 'txt': case 'md': return '📄';
            case 'json': case 'js': case 'html': case 'css': return '📝';
            case 'jpg': case 'jpeg': case 'png': case 'gif': return '🖼️';
            case 'pdf': return '📕';
            case 'zip': case 'rar': return '📦';
            default: return '📄';
        }
    };

    const handleNewFolder = async () => {
        if (!newFolderName.trim()) {
            alert('Please enter a folder name');
            return;
        }

        try {
            const response = await fetch('/api/folders', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    folderName: newFolderName.trim(),
                    currentPath: currentPath
                })
            });

            const result = await response.json();

            if (response.ok) {
                setNewFolderName('');
                setShowNewFolderDialog(false);
                // Refresh the current directory
                fetchFiles(currentPath);
            } else {
                alert(result.error || 'Failed to create folder');
            }
        } catch (error) {
            console.error('Create folder error:', error);
            alert('Failed to create folder');
        }
    };

    const handleFileUpload = async (files) => {
        if (!files || files.length === 0) return;

        setUploading(true);
        const formData = new FormData();

        // Add all files to FormData
        Array.from(files).forEach(file => {
            formData.append('files', file);
        });

        // Add current path
        formData.append('currentPath', currentPath);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                body: formData
            });

            const result = await response.json();

            if (response.ok) {
                alert(result.message || 'Files uploaded successfully');
                // Refresh the current directory
                fetchFiles(currentPath);
            } else {
                alert(result.error || 'Failed to upload files');
            }
        } catch (error) {
            console.error('Upload error:', error);
            alert('Failed to upload files');
        } finally {
            setUploading(false);
        }
    };

    const handleUploadClick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = (e) => handleFileUpload(e.target.files);
        input.click();
    };

    const handleNewFolder = async () => {
        if (!newFolderName.trim()) {
            alert('Please enter a folder name');
            return;
        }

        try {
            const response = await fetch('/api/folders', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    folderName: newFolderName.trim(),
                    currentPath: currentPath
                })
            });

            const result = await response.json();

            if (response.ok) {
                setNewFolderName('');
                setShowNewFolderDialog(false);
                // Refresh the current directory
                fetchFiles(currentPath);
            } else {
                alert(result.error || 'Failed to create folder');
            }
        } catch (error) {
            console.error('Create folder error:', error);
            alert('Failed to create folder');
        }
    };

    const handleFileUpload = async (files) => {
        if (!files || files.length === 0) return;

        setUploading(true);
        const formData = new FormData();

        // Add all files to FormData
        Array.from(files).forEach(file => {
            formData.append('files', file);
        });

        // Add current path
        formData.append('currentPath', currentPath);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                body: formData
            });

            const result = await response.json();

            if (response.ok) {
                alert(result.message || 'Files uploaded successfully');
                // Refresh the current directory
                fetchFiles(currentPath);
            } else {
                alert(result.error || 'Failed to upload files');
            }
        } catch (error) {
            console.error('Upload error:', error);
            alert('Failed to upload files');
        } finally {
            setUploading(false);
        }
    };

    const handleUploadClick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = (e) => handleFileUpload(e.target.files);
        input.click();
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="text-center">
                    <div className="loading-spinner mx-auto mb-4"></div>
                    <p className="text-blue-400">Loading files...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen p-6">
            <div className="max-w-7xl mx-auto">
                {/* Header */}
                <div className="glass-effect rounded-lg p-4 mb-6 flex justify-between items-center">
                    <div>
                        <h1 className="text-2xl font-bold text-blue-400">
                            🗂️ File Manager
                        </h1>
                        <p className="text-sm text-gray-400 mt-1">
                            Welcome, {user?.username || 'User'}!
                        </p>
                    </div>
                    <button
                        onClick={handleLogout}
                        className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded transition-colors"
                    >
                        Logout
                    </button>
                </div>

                {/* Navigation Bar */}
                <div className="glass-effect rounded-lg p-4 mb-6">
                    <div className="flex items-center justify-between">
                        {/* Breadcrumbs */}
                        <div className="flex items-center space-x-2 text-sm">
                            {getBreadcrumbs().map((crumb, index) => (
                                <React.Fragment key={index}>
                                    <button
                                        onClick={() => fetchFiles(crumb.path)}
                                        className={`px-2 py-1 rounded transition-colors ${
                                            crumb.path === currentPath
                                                ? 'bg-blue-600 text-white'
                                                : 'text-blue-400 hover:bg-blue-600 hover:bg-opacity-20'
                                        }`}
                                    >
                                        {crumb.name}
                                    </button>
                                    {index < getBreadcrumbs().length - 1 && (
                                        <span className="text-gray-400">→</span>
                                    )}
                                </React.Fragment>
                            ))}
                        </div>

                        {/* Navigation Buttons */}
                        <div className="flex space-x-2">
                            <button
                                onClick={handleBackClick}
                                disabled={!currentPath}
                                className="px-3 py-1 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-800 disabled:text-gray-500 text-white rounded transition-colors"
                            >
                                ← Back
                            </button>
                            <button
                                onClick={() => fetchFiles(currentPath)}
                                className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
                            >
                                🔄 Refresh
                            </button>
                        </div>
                    </div>
                </div>

                {error && (
                    <div className="bg-red-500 bg-opacity-20 border border-red-500 text-red-200 px-4 py-2 rounded mb-4">
                        {error}
                    </div>
                )}

                {/* File List */}
                <div className="glass-effect rounded-lg p-6">
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="text-lg font-semibold text-blue-300">
                            Files & Folders
                        </h2>
                        <div className="text-sm text-gray-400">
                            {files.length} items
                        </div>
                    </div>

                    {files.length === 0 ? (
                        <div className="text-center py-12 text-gray-400">
                            <div className="text-6xl mb-4">📁</div>
                            <p className="text-lg">This directory is empty</p>
                            <p className="text-sm mt-2">No files or folders found</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {files.map((item, index) => (
                                <div
                                    key={index}
                                    onClick={() => handleItemClick(item)}
                                    className="flex items-center p-4 bg-gray-800 bg-opacity-30 rounded-lg hover:bg-opacity-50 transition-all cursor-pointer group"
                                >
                                    <div className="text-3xl mr-4">
                                        {getFileIcon(item)}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-medium text-white group-hover:text-blue-300 transition-colors">
                                            {item.name}
                                        </div>
                                        <div className="text-sm text-gray-400 truncate">
                                            {item.path}
                                        </div>
                                    </div>
                                    <div className="text-gray-400 group-hover:text-gray-300">
                                        {item.name.includes('.') ? '📄' : '📁→'}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Action Bar */}
                <div className="glass-effect rounded-lg p-4 mt-6">
                    <div className="flex justify-between items-center">
                        <div className="flex space-x-2">
                            <button className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded transition-colors">
                                📁 New Folder
                            </button>
                            <button className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors">
                                📤 Upload Files
                            </button>
                        </div>
                        <div className="text-sm text-gray-400">
                            Current: /{currentPath || 'storage'}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// Main App Component
const App = () => {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(localStorage.getItem('token'));
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const initializeAuth = async () => {
            const storedToken = localStorage.getItem('token');

            if (storedToken) {
                try {
                    // Verify token is still valid by making a test API call
                    const response = await fetch('/api/files/', {
                        headers: { 'Authorization': `Bearer ${storedToken}` }
                    });

                    if (response.ok) {
                        // Token is valid, set user info
                        console.log('Token verified successfully');
                        setUser({ id: 1, username: 'admin', role: 'admin' });
                        setToken(storedToken);
                    } else {
                        // Token is invalid
                        console.log('Token verification failed:', response.status);
                        localStorage.removeItem('token');
                        setToken(null);
                        setUser(null);
                    }
                } catch (error) {
                    // Network error
                    console.error('Token verification error:', error);
                    localStorage.removeItem('token');
                    setToken(null);
                    setUser(null);
                }
            }

            setIsLoading(false);
        };

        initializeAuth();
    }, []);

    const handleLogin = (userData, userToken) => {
        setUser(userData);
        setToken(userToken);
        localStorage.setItem('token', userToken);
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="text-center">
                    <div className="loading-spinner mx-auto mb-4"></div>
                    <p className="text-blue-400">Initializing...</p>
                </div>
            </div>
        );
    }

    if (!token || !user) {
        return <LoginForm onLogin={handleLogin} />;
    }

    return <FileBrowser token={token} user={user} />;
};

// Render the app
ReactDOM.render(<App />, document.getElementById('root'));
