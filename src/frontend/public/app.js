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
        <div className="min-h-screen flex items-center justify-center bg-gray-100">
            <div className="explorer-window rounded-lg p-8 w-full max-w-md">
                <div className="text-center mb-6">
                    <div style={{fontSize: '48px', marginBottom: '16px'}}>📁</div>
                    <h2 className="text-xl font-semibold text-gray-800">
                        File Explorer Login
                    </h2>
                </div>

                {error && (
                    <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-2 rounded mb-4">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    <div className="mb-4">
                        <label className="block text-sm font-medium mb-2 text-gray-700">Username</label>
                        <input
                            type="text"
                            value={credentials.username}
                            onChange={(e) => setCredentials({...credentials, username: e.target.value})}
                            className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500"
                            required
                        />
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium mb-2 text-gray-700">Password</label>
                        <input
                            type="password"
                            value={credentials.password}
                            onChange={(e) => setCredentials({...credentials, password: e.target.value})}
                            className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500"
                            required
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white font-medium py-2 px-4 rounded transition-colors"
                    >
                        {loading ? 'Logging in...' : 'Login'}
                    </button>
                </form>

                <div className="mt-4 text-center text-sm text-gray-500">
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
    const [dragOver, setDragOver] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);

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
            // Directory - use Windows-style folder icon
            return '📂';
        }

        // File - determine type by extension (Windows-style)
        const ext = item.name.split('.').pop().toLowerCase();
        switch (ext) {
            case 'txt': case 'log': case 'md': return '📄';
            case 'doc': case 'docx': return '📘';
            case 'xls': case 'xlsx': return '📗';
            case 'ppt': case 'pptx': return '📙';
            case 'pdf': return '📕';
            case 'jpg': case 'jpeg': case 'png': case 'gif': case 'bmp': case 'ico': return '🖼️';
            case 'mp4': case 'avi': case 'mov': case 'wmv': return '🎬';
            case 'mp3': case 'wav': case 'wma': return '🎵';
            case 'zip': case 'rar': case 'tar': case 'gz': return '📦';
            case 'exe': case 'msi': return '⚙️';
            case 'js': case 'html': case 'css': case 'json': return '💻';
            case 'py': case 'java': case 'cpp': case 'c': return '👨‍💻';
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

    // Drag and Drop handlers
    const handleDragEnter = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(true);
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Only set dragOver to false if we're leaving the main container
        if (!e.currentTarget.contains(e.relatedTarget)) {
            setDragOver(false);
        }
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(true);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);

        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            handleFileUpload(files);
        }
    };



    return (
        <div
            className="min-h-screen bg-gray-100"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            <div className="h-screen flex flex-col">
                {/* Title Bar */}
                <div className="bg-white border-b border-gray-300 px-4 py-2 flex justify-between items-center">
                    <div className="flex items-center">
                        <span className="text-sm font-medium">📁 File Explorer</span>
                    </div>
                    <div className="flex items-center space-x-2">
                        <span className="text-sm text-gray-600">Welcome, {user?.username}</span>
                        <button
                            onClick={handleLogout}
                            className="text-sm px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600"
                        >
                            Logout
                        </button>
                    </div>
                </div>

                {/* Toolbar */}
                <div className="toolbar">
                    <button
                        onClick={handleBackClick}
                        disabled={!currentPath}
                        className="toolbar-button"
                        title="Back"
                    >
                        ← Back
                    </button>
                    <button
                        onClick={() => fetchFiles(currentPath)}
                        className="toolbar-button"
                        title="Refresh"
                    >
                        🔄 Refresh
                    </button>
                    <button
                        onClick={() => setShowNewFolderDialog(true)}
                        className="toolbar-button"
                        title="New Folder"
                    >
                        📁 New Folder
                    </button>
                    <button
                        onClick={handleUploadClick}
                        disabled={uploading}
                        className="toolbar-button"
                        title="Upload Files"
                    >
                        {uploading ? '⏳ Uploading...' : '📤 Upload'}
                    </button>

                    {/* Address Bar */}
                    <div className="address-bar">
                        {getBreadcrumbs().map((crumb, index) => (
                            <span key={index}>
                                <button
                                    onClick={() => fetchFiles(crumb.path)}
                                    className="text-blue-600 hover:underline"
                                >
                                    {crumb.name}
                                </button>
                                {index < getBreadcrumbs().length - 1 && <span className="mx-1">›</span>}
                            </span>
                        ))}
                    </div>
                </div>

                {/* File List */}
                <div className="file-list flex-1 overflow-auto">
                    {loading ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-center">
                                <div className="loading-spinner mx-auto mb-2"></div>
                                <p className="text-sm text-gray-600">Loading files...</p>
                            </div>
                        </div>
                    ) : error ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-center text-red-600">
                                <p>❌ {error}</p>
                            </div>
                        </div>
                    ) : files.length === 0 ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-center text-gray-500">
                                <p>📁 This folder is empty</p>
                            </div>
                        </div>
                    ) : (
                        files.map((item, index) => (
                            <div
                                key={index}
                                onClick={() => handleItemClick(item)}
                                className="file-item"
                            >
                                <div className="file-icon">
                                    {getFileIcon(item)}
                                </div>
                                <div className="file-name">
                                    {item.name}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Status Bar */}
                <div className="status-bar">
                    {files.length} items | Current: /{currentPath || 'storage'}
                </div>
            </div>

            {/* Drag and Drop Overlay */}
            {dragOver && (
                <div className="drag-overlay">
                    <div className="drag-message">
                        <div style={{fontSize: '48px', marginBottom: '16px'}}>📤</div>
                        <h2 style={{fontSize: '18px', fontWeight: '600', marginBottom: '8px'}}>Drop files here</h2>
                        <p style={{color: '#666', fontSize: '14px'}}>Release to upload files to current folder</p>
                    </div>
                </div>
            )}

            {/* Upload Progress */}
            {uploading && (
                <div style={{
                    position: 'fixed',
                    bottom: '16px',
                    right: '16px',
                    background: 'white',
                    padding: '12px 16px',
                    borderRadius: '8px',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    zIndex: 100
                }}>
                    <div className="loading-spinner"></div>
                    <span style={{fontSize: '14px'}}>Uploading files...</span>
                </div>
            )}

            {/* New Folder Dialog */}
            {showNewFolderDialog && (
                <div className="modal-overlay">
                    <div className="modal">
                        <div className="modal-header">Create New Folder</div>
                        <input
                            type="text"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            placeholder="Enter folder name"
                            className="modal-input"
                            onKeyPress={(e) => e.key === 'Enter' && handleNewFolder()}
                            autoFocus
                        />
                        <div className="modal-buttons">
                            <button
                                onClick={() => {
                                    setShowNewFolderDialog(false);
                                    setNewFolderName('');
                                }}
                                className="modal-button"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleNewFolder}
                                className="modal-button primary"
                            >
                                Create
                            </button>
                        </div>
                    </div>
                </div>
            )}
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
