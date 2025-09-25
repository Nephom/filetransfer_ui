// File Transfer UI - Simple Application
console.log('App: Starting...');

// Check dependencies
if (typeof React === 'undefined' || typeof ReactDOM === 'undefined') {
    console.error('App: React dependencies missing');
    document.getElementById('root').innerHTML = `
        <div style="
            min-height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            text-align: center;
            padding: 20px;
        ">
            <div style="
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(20px);
                border-radius: 20px;
                padding: 40px;
                border: 1px solid rgba(255, 255, 255, 0.2);
            ">
                <h2 style="margin: 0 0 16px 0; color: #ef4444;">❌ Dependencies Missing</h2>
                <p style="margin: 0; opacity: 0.8;">React or ReactDOM failed to load.</p>
            </div>
        </div>
    `;
} else {
    console.log('App: Dependencies OK');
    
    // Login Form Component
    const LoginForm = ({ onLogin }) => {
        const [credentials, setCredentials] = React.useState({ username: '', password: '' });
        const [loading, setLoading] = React.useState(false);
        const [error, setError] = React.useState('');

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

        return React.createElement('div', {
            style: {
                minHeight: '100vh',
                background: 'linear-gradient(135deg, #2c3e50 0%, #34495e 25%, #5dade2 50%, #85c1e9 75%, #aed6f1 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }
        }, React.createElement('div', {
            style: {
                background: 'rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(20px)',
                borderRadius: '24px',
                padding: '40px',
                width: '100%',
                maxWidth: '420px',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)'
            }
        }, [
            // Header
            React.createElement('div', {
                key: 'header',
                style: { textAlign: 'center', marginBottom: '32px' }
            }, [
                React.createElement('div', {
                    key: 'icon',
                    style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '80px',
                        height: '80px',
                        background: 'linear-gradient(135deg, #5dade2, #85c1e9)',
                        borderRadius: '50%',
                        marginBottom: '16px',
                        boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
                        fontSize: '32px'
                    }
                }, '📁'),
                React.createElement('h2', {
                    key: 'title',
                    style: {
                        color: 'white',
                        margin: 0,
                        fontSize: '28px',
                        fontWeight: 'bold',
                        marginBottom: '8px'
                    }
                }, 'File Transfer UI'),
                React.createElement('p', {
                    key: 'subtitle',
                    style: {
                        color: 'rgba(255, 255, 255, 0.8)',
                        margin: 0,
                        fontSize: '16px'
                    }
                }, 'Futuristic File Management System')
            ]),

            // Error message
            error && React.createElement('div', {
                key: 'error',
                style: {
                    background: 'rgba(239, 68, 68, 0.2)',
                    border: '1px solid rgba(239, 68, 68, 0.5)',
                    color: 'white',
                    padding: '12px 16px',
                    borderRadius: '12px',
                    marginBottom: '24px',
                    backdropFilter: 'blur(10px)',
                    display: 'flex',
                    alignItems: 'center'
                }
            }, [
                React.createElement('span', {
                    key: 'icon',
                    style: { marginRight: '8px' }
                }, '⚠️'),
                React.createElement('span', { key: 'text' }, error)
            ]),

            // Form
            React.createElement('form', {
                key: 'form',
                onSubmit: handleSubmit
            }, [
                // Username field
                React.createElement('div', {
                    key: 'username',
                    style: { marginBottom: '24px' }
                }, [
                    React.createElement('label', {
                        key: 'label',
                        style: {
                            display: 'block',
                            color: 'rgba(255, 255, 255, 0.9)',
                            marginBottom: '8px',
                            fontSize: '14px',
                            fontWeight: '500'
                        }
                    }, 'Username'),
                    React.createElement('input', {
                        key: 'input',
                        type: 'text',
                        value: credentials.username,
                        onChange: (e) => setCredentials({...credentials, username: e.target.value}),
                        style: {
                            width: '100%',
                            padding: '16px',
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '12px',
                            color: 'white',
                            fontSize: '16px',
                            boxSizing: 'border-box',
                            backdropFilter: 'blur(10px)',
                            transition: 'all 0.3s ease',
                            outline: 'none'
                        },
                        placeholder: 'Enter your username',
                        required: true
                    })
                ]),

                // Password field
                React.createElement('div', {
                    key: 'password',
                    style: { marginBottom: '32px' }
                }, [
                    React.createElement('label', {
                        key: 'label',
                        style: {
                            display: 'block',
                            color: 'rgba(255, 255, 255, 0.9)',
                            marginBottom: '8px',
                            fontSize: '14px',
                            fontWeight: '500'
                        }
                    }, 'Password'),
                    React.createElement('input', {
                        key: 'input',
                        type: 'password',
                        value: credentials.password,
                        onChange: (e) => setCredentials({...credentials, password: e.target.value}),
                        style: {
                            width: '100%',
                            padding: '16px',
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '12px',
                            color: 'white',
                            fontSize: '16px',
                            boxSizing: 'border-box',
                            backdropFilter: 'blur(10px)',
                            transition: 'all 0.3s ease',
                            outline: 'none'
                        },
                        placeholder: 'Enter your password',
                        required: true
                    })
                ]),

                // Submit button
                React.createElement('button', {
                    key: 'submit',
                    type: 'submit',
                    disabled: loading,
                    style: {
                        width: '100%',
                        background: loading ? 'rgba(93, 173, 226, 0.5)' : 'linear-gradient(135deg, #5dade2, #85c1e9)',
                        border: 'none',
                        borderRadius: '12px',
                        color: 'white',
                        fontSize: '16px',
                        fontWeight: '600',
                        padding: '16px',
                        cursor: loading ? 'not-allowed' : 'pointer',
                        transition: 'all 0.3s ease',
                        boxShadow: '0 4px 15px rgba(0, 0, 0, 0.2)',
                        outline: 'none'
                    }
                }, loading ? 'Logging in...' : '🚀 Login')
            ]),

            // Info
            React.createElement('div', {
                key: 'info',
                style: {
                    textAlign: 'center',
                    marginTop: '24px',
                    background: 'rgba(59, 130, 246, 0.2)',
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                    borderRadius: '12px',
                    padding: '16px',
                    backdropFilter: 'blur(10px)'
                }
            }, React.createElement('p', {
                style: {
                    color: 'rgba(255, 255, 255, 0.9)',
                    margin: 0,
                    fontSize: '14px'
                }
            }, 'Default: admin / password'))
        ]));
    };

    // File Browser Component
    const FileBrowser = ({ token, user }) => {
        const [files, setFiles] = React.useState([]);
        const [loading, setLoading] = React.useState(true);
        const [error, setError] = React.useState('');
        const [currentPath, setCurrentPath] = React.useState('');
        const [selectedFiles, setSelectedFiles] = React.useState([]);
        const [viewMode, setViewMode] = React.useState('grid');
        const [searchQuery, setSearchQuery] = React.useState('');
        const [showUploadModal, setShowUploadModal] = React.useState(false);
        const [uploadProgress, setUploadProgress] = React.useState({});
        const [pathHistory, setPathHistory] = React.useState([]);
        const [contextMenu, setContextMenu] = React.useState(null);
        const [clipboard, setClipboard] = React.useState({ items: [], operation: null });
        const [searchResults, setSearchResults] = React.useState([]);
        const [isSearching, setIsSearching] = React.useState(false);

        React.useEffect(() => {
            fetchFiles();
        }, [currentPath]);

        // Debounced search effect
        React.useEffect(() => {
            const timeoutId = setTimeout(() => {
                performSearch(searchQuery);
            }, 300);

            return () => clearTimeout(timeoutId);
        }, [searchQuery, currentPath]);

        // Add global click handler to close context menu
        React.useEffect(() => {
            const handleGlobalClick = () => {
                if (contextMenu) {
                    closeContextMenu();
                }
            };

            document.addEventListener('click', handleGlobalClick);
            return () => document.removeEventListener('click', handleGlobalClick);
        }, [contextMenu]);

        const fetchFiles = async () => {
            setLoading(true);
            setError('');
            try {
                const url = currentPath ? `/api/files/${encodeURIComponent(currentPath)}` : '/api/files';
                const response = await fetch(url, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (response.ok) {
                    const data = await response.json();
                    setFiles(data);
                } else {
                    setError('Failed to load files');
                }
            } catch (error) {
                setError('Connection error');
            } finally {
                setLoading(false);
            }
        };

        // Search function
        const performSearch = async (query) => {
            if (!query.trim()) {
                setSearchResults([]);
                setIsSearching(false);
                setError(''); // Clear any previous search errors
                return;
            }

            setIsSearching(true);
            setError(''); // Clear any previous errors when starting new search
            try {
                const response = await fetch(`/api/files/search?query=${encodeURIComponent(query)}&path=`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.ok) {
                    const results = await response.json();
                    setSearchResults(results);
                } else {
                    setError('Search failed');
                    setSearchResults([]);
                }
            } catch (error) {
                console.error('Search error:', error);
                setError(`Search failed: ${error.message}`);
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        };

        const closeContextMenu = () => {
            setContextMenu(null);
        };

        // Handle context menu on empty area
        const handleEmptyAreaContextMenu = (e) => {
            e.preventDefault();
            e.stopPropagation();

            setContextMenu({
                x: e.clientX,
                y: e.clientY,
                file: null,
                selectedFiles: [],
                isEmptyArea: true
            });
        };

        const navigateToFolder = (folderPath, folderName) => {
            setPathHistory([...pathHistory, { path: currentPath, name: currentPath || 'Root' }]);

            // Convert full path to relative path
            // Remove ./storage/ prefix to get relative path
            const relativePath = folderPath.replace(/^\.\/storage\/?/, '');
            const newPath = currentPath ? `${currentPath}/${folderName}` : folderName;

            setCurrentPath(newPath);
            setSelectedFiles([]);
        };

        const navigateBack = () => {
            if (pathHistory.length > 0) {
                const previous = pathHistory[pathHistory.length - 1];
                setCurrentPath(previous.path);
                setPathHistory(pathHistory.slice(0, -1));
                setSelectedFiles([]);
            }
        };

        const toggleFileSelection = (file) => {
            const isSelected = selectedFiles.some(f => f.path === file.path);
            if (isSelected) {
                setSelectedFiles(selectedFiles.filter(f => f.path !== file.path));
            } else {
                setSelectedFiles([...selectedFiles, file]);
            }
        };

        const selectAllFiles = () => {
            if (selectedFiles.length === files.length) {
                setSelectedFiles([]);
            } else {
                setSelectedFiles([...files]);
            }
        };

        const deleteSelectedFiles = async () => {
            if (selectedFiles.length === 0) return;

            const confirmMessage = selectedFiles.length === 1
                ? `Are you sure you want to delete "${selectedFiles[0].name}"?`
                : `Are you sure you want to delete ${selectedFiles.length} selected files?`;

            if (!confirm(confirmMessage)) return;

            try {
                for (const file of selectedFiles) {
                    const filePath = currentPath ? `${currentPath}/${file.name}` : file.name;
                    const response = await fetch(`/api/files/${encodeURIComponent(filePath)}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });

                    if (!response.ok) {
                        throw new Error(`Failed to delete ${file.name}`);
                    }
                }

                setSelectedFiles([]);
                fetchFiles();
            } catch (error) {
                setError(`Delete failed: ${error.message}`);
            }
        };

        const downloadFile = async (file) => {
            try {
                // Construct the file path relative to storage
                const filePath = currentPath ? `${currentPath}/${file.name}` : file.name;

                // Create download URL
                const downloadUrl = `/api/files/download/${encodeURIComponent(filePath)}`;

                // Create a temporary link element and trigger download
                const link = document.createElement('a');
                link.href = downloadUrl;
                link.download = file.name;

                // Add authorization header by fetching the file first
                const response = await fetch(downloadUrl, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.status === 409) {
                    const data = await response.json();
                    alert(data.error);
                    return;
                }

                if (!response.ok) {
                    throw new Error(`Download failed: ${response.statusText}`);
                }

                // Create blob from response and download
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                link.href = url;

                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                // Clean up the blob URL
                window.URL.revokeObjectURL(url);

                console.log(`Downloaded: ${file.name}`);
            } catch (error) {
                console.error('Download error:', error);
                setError(`Download failed: ${error.message}`);
            }
        };

        const createNewFolder = async () => {
            const folderName = prompt('Enter folder name:');
            if (!folderName) return;

            try {
                const response = await fetch('/api/folders', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        folderName: folderName,
                        currentPath: currentPath
                    })
                });

                if (response.ok) {
                    fetchFiles();
                } else {
                    throw new Error('Failed to create folder');
                }
            } catch (error) {
                setError(`Create folder failed: ${error.message}`);
            }
        };

        const handleRefresh = async () => {
            setLoading(true);
            setError('');
            try {
                const response = await fetch('/api/files/refresh-cache', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (response.ok) {
                    await fetchFiles();
                } else {
                    setError('Failed to refresh cache');
                }
            } catch (error) {
                setError('Connection error during refresh');
            } finally {
                setLoading(false);
            }
        };

        const handleFileUpload = async (uploadingFiles) => {
            const existingFiles = files;
            const filesToUpload = [];

            for (let i = 0; i < uploadingFiles.length; i++) {
                const file = uploadingFiles[i];
                const isExisting = existingFiles.some(existingFile => existingFile.name === file.name);

                if (isExisting) {
                    if (window.confirm(`File "${file.name}" already exists. Do you want to overwrite it?`)) {
                        filesToUpload.push(file);
                    }
                } else {
                    filesToUpload.push(file);
                }
            }

            if (filesToUpload.length === 0) {
                return;
            }

            const formData = new FormData();
            for (let i = 0; i < filesToUpload.length; i++) {
                formData.append('files', filesToUpload[i]);
            }

            if (currentPath) {
                formData.append('currentPath', currentPath);
            }

            try {
                const response = await fetch('/api/upload', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                    body: formData
                });

                if (response.ok) {
                    setShowUploadModal(false);
                    fetchFiles();
                } else {
                    throw new Error('Upload failed');
                }
            } catch (error) {
                setError(`Upload failed: ${error.message}`);
            }
        };

        const handleDragOver = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        const handleDrop = (e) => {
            e.preventDefault();
            e.stopPropagation();

            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
                handleFileUpload(files);
            }
        };





        // Use search results if searching, otherwise use current directory files
        const filteredFiles = searchQuery.trim() ? searchResults : files;

        const getFileIcon = (file) => {
            if (file.isDirectory) return '📂'; // Folder

            const fileName = file.name;
            if (!fileName.includes('.')) return '📄'; // File without extension

            const ext = fileName.split('.').pop().toLowerCase();
            const iconMap = {
                'pdf': '📄',
                'doc': '📝', 'docx': '📝',
                'xls': '📊', 'xlsx': '📊',
                'ppt': '📊', 'pptx': '📊',
                'txt': '📄',
                'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️',
                'mp4': '🎬', 'avi': '🎬', 'mov': '🎬',
                'mp3': '🎵', 'wav': '🎵',
                'zip': '📦', 'rar': '📦', '7z': '📦',
                'js': '⚡', 'html': '🌐', 'css': '🎨',
                'py': '🐍', 'java': '☕', 'cpp': '⚙️'
            };

            return iconMap[ext] || '📄';
        };

        // Context menu functions
        const handleContextMenu = (e, file) => {
            e.preventDefault();
            e.stopPropagation();

            // If the file is not selected, select it
            if (!selectedFiles.some(f => f.name === file.name)) {
                setSelectedFiles([file]);
            }

            setContextMenu({
                x: e.clientX,
                y: e.clientY,
                file: file,
                selectedFiles: selectedFiles.some(f => f.name === file.name) ? selectedFiles : [file]
            });
        };



        const handleCopy = () => {
            const itemsWithPath = contextMenu.selectedFiles.map(file => ({
                ...file,
                currentPath: currentPath
            }));
            setClipboard({ items: itemsWithPath, operation: 'copy' });
            closeContextMenu();
        };

        const handleCut = () => {
            const itemsWithPath = contextMenu.selectedFiles.map(file => ({
                ...file,
                currentPath: currentPath
            }));
            setClipboard({ items: itemsWithPath, operation: 'cut' });
            closeContextMenu();
        };

        const handlePaste = async () => {
            if (!clipboard.items.length) return;

            try {
                const response = await fetch('/api/files/paste', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        items: clipboard.items,
                        operation: clipboard.operation,
                        targetPath: currentPath
                    })
                });

                if (response.ok) {
                    fetchFiles();
                    if (clipboard.operation === 'cut') {
                        setClipboard({ items: [], operation: null });
                    }
                } else {
                    const data = await response.json();
                    setError(data.error || 'Paste operation failed');
                }
            } catch (error) {
                setError(`Paste failed: ${error.message}`);
            }
            closeContextMenu();
        };

        const handleRename = () => {
            const file = contextMenu.file;
            const newName = prompt('Enter new name:', file.name);
            if (newName && newName !== file.name) {
                renameFile(file, newName);
            }
            closeContextMenu();
        };

        const handleDeleteFromContext = () => {
            if (confirm(`Are you sure you want to delete ${contextMenu.selectedFiles.length} item(s)?`)) {
                deleteFiles(contextMenu.selectedFiles);
            }
            closeContextMenu();
        };

        const renameFile = async (file, newName) => {
            try {
                const response = await fetch('/api/files/rename', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        oldName: file.name,
                        newName: newName,
                        currentPath: currentPath
                    })
                });

                if (response.ok) {
                    fetchFiles();
                } else {
                    const data = await response.json();
                    setError(data.error || 'Rename failed');
                }
            } catch (error) {
                setError(`Rename failed: ${error.message}`);
            }
        };

        const handleLogout = () => {
            localStorage.removeItem('token');
            window.location.reload();
        };

        if (loading) {
            return React.createElement('div', {
                style: {
                    minHeight: '100vh',
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white'
                }
            }, React.createElement('div', {
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '20px',
                    padding: '40px',
                    textAlign: 'center',
                    border: '1px solid rgba(255, 255, 255, 0.2)'
                }
            }, [
                React.createElement('div', {
                    key: 'spinner',
                    style: {
                        width: '40px',
                        height: '40px',
                        border: '3px solid rgba(255, 255, 255, 0.3)',
                        borderTop: '3px solid white',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite',
                        margin: '0 auto 20px'
                    }
                }),
                React.createElement('p', {
                    key: 'text',
                    style: { margin: 0, fontSize: '18px' }
                }, 'Loading files...')
            ]));
        }

        // Create file items
        const fileItems = files.map((file, index) => {
            return React.createElement('div', {
                key: index,
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(10px)',
                    borderRadius: '12px',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    padding: '16px',
                    cursor: 'pointer',
                    transition: 'all 0.3s ease',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px'
                }
            }, [
                React.createElement('div', {
                    key: 'icon',
                    style: { fontSize: '32px' }
                }, file.name.includes('.') ? '📄' : '📂'),
                React.createElement('div', {
                    key: 'info',
                    style: { flex: 1, minWidth: 0 }
                }, [
                    React.createElement('p', {
                        key: 'name',
                        style: {
                            color: 'white',
                            margin: 0,
                            fontSize: '16px',
                            fontWeight: '500',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                        }
                    }, file.name),
                    React.createElement('p', {
                        key: 'type',
                        style: {
                            color: 'rgba(255, 255, 255, 0.7)',
                            margin: 0,
                            fontSize: '12px',
                            marginTop: '4px'
                        }
                    }, file.name.includes('.') ? 'File' : 'Folder')
                ])
            ]);
        });



        return React.createElement('div', {
            style: {
                minHeight: '100vh',
                background: 'linear-gradient(135deg, #2c3e50 0%, #34495e 25%, #5dade2 50%, #85c1e9 75%, #aed6f1 100%)',
                color: 'white',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            },
            onDragOver: handleDragOver,
            onDrop: handleDrop
        }, [
            // Header
            React.createElement('div', {
                key: 'header',
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
                    padding: '16px 24px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                }
            }, [
                React.createElement('div', {
                    key: 'logo',
                    style: { display: 'flex', alignItems: 'center', gap: '12px' }
                }, [
                    React.createElement('div', {
                        key: 'icon',
                        style: {
                            width: '40px',
                            height: '40px',
                            background: 'linear-gradient(135deg, #5dade2, #85c1e9)',
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '20px'
                        }
                    }, '📁'),
                    React.createElement('div', { key: 'text' }, [
                        React.createElement('h1', {
                            key: 'title',
                            style: { margin: 0, fontSize: '20px', fontWeight: 'bold' }
                        }, 'File Transfer UI'),
                        React.createElement('p', {
                            key: 'subtitle',
                            style: { margin: 0, fontSize: '12px', opacity: 0.8 }
                        }, 'Futuristic File Management')
                    ])
                ]),
                React.createElement('div', {
                    key: 'user',
                    style: { display: 'flex', alignItems: 'center', gap: '16px' }
                }, [
                    React.createElement('span', {
                        key: 'welcome',
                        style: { fontSize: '14px' }
                    }, `Welcome, ${user?.username}`),
                    React.createElement('button', {
                        key: 'logout',
                        onClick: handleLogout,
                        style: {
                            background: 'rgba(239, 68, 68, 0.2)',
                            border: '1px solid rgba(239, 68, 68, 0.5)',
                            borderRadius: '8px',
                            color: 'white',
                            padding: '8px 16px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            outline: 'none'
                        }
                    }, '🚪 Logout')
                ])
            ]),

            // Navigation Bar
            React.createElement('div', {
                key: 'navbar',
                style: {
                    background: 'rgba(255, 255, 255, 0.05)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                    padding: '12px 24px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px'
                }
            }, [
                // Back button
                React.createElement('button', {
                    key: 'back',
                    onClick: navigateBack,
                    disabled: pathHistory.length === 0,
                    style: {
                        background: pathHistory.length === 0 ? 'rgba(255, 255, 255, 0.1)' : 'rgba(59, 130, 246, 0.2)',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '8px',
                        color: pathHistory.length === 0 ? 'rgba(255, 255, 255, 0.5)' : 'white',
                        padding: '8px 12px',
                        cursor: pathHistory.length === 0 ? 'not-allowed' : 'pointer',
                        fontSize: '14px',
                        outline: 'none'
                    }
                }, '← Back'),

                // Path breadcrumb
                React.createElement('div', {
                    key: 'breadcrumb',
                    style: {
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        color: 'rgba(255, 255, 255, 0.8)'
                    }
                }, [
                    React.createElement('span', { key: 'home' }, '🏠'),
                    React.createElement('span', { key: 'path' }, currentPath || 'Root')
                ])
            ]),

            // Toolbar
            React.createElement('div', {
                key: 'toolbar',
                style: {
                    background: 'rgba(255, 255, 255, 0.05)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                    padding: '16px 24px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '16px'
                }
            }, [
                // Left side - Action buttons
                React.createElement('div', {
                    key: 'actions',
                    style: { display: 'flex', alignItems: 'center', gap: '12px' }
                }, [
                    React.createElement('button', {
                        key: 'upload',
                        onClick: () => setShowUploadModal(true),
                        style: {
                            background: 'linear-gradient(135deg, #52c41a, #389e0d)',
                            border: 'none',
                            borderRadius: '8px',
                            color: 'white',
                            padding: '10px 16px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            fontWeight: '500',
                            outline: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }
                    }, ['📤', ' Upload']),

                    React.createElement('button', {
                        key: 'newfolder',
                        onClick: createNewFolder,
                        style: {
                            background: 'rgba(93, 173, 226, 0.2)',
                            border: '1px solid rgba(93, 173, 226, 0.5)',
                            borderRadius: '8px',
                            color: 'white',
                            padding: '10px 16px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            outline: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }
                    }, ['📁', ' New Folder']),

                    React.createElement('button', {
                        key: 'refresh',
                        onClick: handleRefresh,
                        style: {
                            background: 'rgba(255, 165, 0, 0.2)',
                            border: '1px solid rgba(255, 165, 0, 0.5)',
                            borderRadius: '8px',
                            color: 'white',
                            padding: '10px 16px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            outline: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }
                    }, ['🔄', ' Refresh']),
                    selectedFiles.length > 0 && React.createElement('button', {
                        key: 'delete',
                        onClick: deleteSelectedFiles,
                        style: {
                            background: 'rgba(239, 68, 68, 0.2)',
                            border: '1px solid rgba(239, 68, 68, 0.5)',
                            borderRadius: '8px',
                            color: 'white',
                            padding: '10px 16px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            outline: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }
                    }, ['🗑️', ` Delete (${selectedFiles.length})`])
                ]),

                // Right side - View controls and search
                React.createElement('div', {
                    key: 'controls',
                    style: { display: 'flex', alignItems: 'center', gap: '12px' }
                }, [
                    // Search box
                    React.createElement('div', {
                        key: 'search',
                        style: { position: 'relative' }
                    }, [
                        React.createElement('input', {
                            key: 'input',
                            type: 'text',
                            placeholder: 'Search files...',
                            value: searchQuery,
                            onChange: (e) => setSearchQuery(e.target.value),
                            style: {
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '8px',
                                color: 'white',
                                padding: '8px 12px 8px 36px',
                                fontSize: '14px',
                                outline: 'none',
                                width: '200px'
                            }
                        }),
                        React.createElement('div', {
                            key: 'icon',
                            style: {
                                position: 'absolute',
                                left: '12px',
                                top: '50%',
                                transform: 'translateY(-50%)',
                                color: 'rgba(255, 255, 255, 0.6)',
                                fontSize: '14px'
                            }
                        }, '🔍')
                    ]),

                    // View mode toggle
                    React.createElement('div', {
                        key: 'viewmode',
                        style: { display: 'flex', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '8px', padding: '2px' }
                    }, [
                        React.createElement('button', {
                            key: 'grid',
                            onClick: () => setViewMode('grid'),
                            style: {
                                background: viewMode === 'grid' ? 'rgba(59, 130, 246, 0.5)' : 'transparent',
                                border: 'none',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '6px 10px',
                                cursor: 'pointer',
                                fontSize: '14px',
                                outline: 'none'
                            }
                        }, '⊞'),
                        React.createElement('button', {
                            key: 'list',
                            onClick: () => setViewMode('list'),
                            style: {
                                background: viewMode === 'list' ? 'rgba(59, 130, 246, 0.5)' : 'transparent',
                                border: 'none',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '6px 10px',
                                cursor: 'pointer',
                                fontSize: '14px',
                                outline: 'none'
                            }
                        }, '☰')
                    ])
                ])
            ]),

            // Main content
            React.createElement('div', {
                key: 'main',
                style: { padding: '24px' }
            }, React.createElement('div', {
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '20px',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                    overflow: 'hidden'
                }
            }, [
                // File list header
                React.createElement('div', {
                    key: 'listheader',
                    style: {
                        padding: '20px 24px',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                    }
                }, [
                    React.createElement('h2', {
                        key: 'title',
                        style: { color: 'white', margin: 0, fontSize: '20px', fontWeight: '600' }
                    }, `Files (${filteredFiles.length}${filteredFiles.length !== files.length ? ` of ${files.length}` : ''})`),

                    files.length > 0 && React.createElement('div', {
                        key: 'selectall',
                        style: { display: 'flex', alignItems: 'center', gap: '8px' }
                    }, [
                        React.createElement('input', {
                            key: 'checkbox',
                            type: 'checkbox',
                            checked: selectedFiles.length === files.length && files.length > 0,
                            onChange: selectAllFiles,
                            style: { cursor: 'pointer' }
                        }),
                        React.createElement('span', {
                            key: 'label',
                            style: { fontSize: '14px', color: 'rgba(255, 255, 255, 0.8)' }
                        }, 'Select All')
                    ])
                ]),

                React.createElement('div', {
                    key: 'content',
                    style: { padding: '24px' }
                }, error ? React.createElement('div', {
                    style: {
                        textAlign: 'center',
                        padding: '40px',
                        color: '#ef4444'
                    }
                }, [
                    React.createElement('div', {
                        key: 'error-icon',
                        style: { fontSize: '48px', marginBottom: '16px' }
                    }, '❌'),
                    React.createElement('p', {
                        key: 'error-text',
                        style: { margin: 0, fontSize: '16px' }
                    }, error)
                ]) : filteredFiles.length === 0 ? React.createElement('div', {
                    style: {
                        textAlign: 'center',
                        padding: '60px',
                        color: 'rgba(255, 255, 255, 0.8)'
                    }
                }, [
                    React.createElement('div', {
                        key: 'empty-icon',
                        style: { fontSize: '64px', marginBottom: '16px' }
                    }, searchQuery ? '🔍' : '📁'),
                    React.createElement('p', {
                        key: 'empty-text',
                        style: { margin: 0, fontSize: '18px' }
                    }, searchQuery ? `No files found matching "${searchQuery}"` : 'This folder is empty'),
                    searchQuery && React.createElement('button', {
                        key: 'clear',
                        onClick: () => setSearchQuery(''),
                        style: {
                            background: 'rgba(59, 130, 246, 0.2)',
                            border: '1px solid rgba(59, 130, 246, 0.5)',
                            borderRadius: '8px',
                            color: 'white',
                            padding: '8px 16px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            outline: 'none',
                            marginTop: '16px'
                        }
                    }, 'Clear Search')
                ]) : React.createElement('div', {
                    style: viewMode === 'grid' ? {
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                        gap: '16px'
                    } : {
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px'
                    },
                    onContextMenu: handleEmptyAreaContextMenu
                }, filteredFiles.map((file, index) => {
                    const isSelected = selectedFiles.some(f => f.path === file.path);
                    const isFolder = file.isDirectory;

                    return React.createElement('div', {
                        key: index,
                        style: {
                            background: isSelected ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                            backdropFilter: 'blur(10px)',
                            borderRadius: '12px',
                            border: isSelected ? '2px solid rgba(59, 130, 246, 0.8)' : '1px solid rgba(255, 255, 255, 0.2)',
                            padding: '16px',
                            cursor: 'pointer',
                            transition: 'all 0.3s ease',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            position: 'relative'
                        },
                        onClick: (e) => {
                            if (e.ctrlKey || e.metaKey) {
                                toggleFileSelection(file);
                            } else if (isFolder) {
                                navigateToFolder(file.path, file.name);
                            } else {
                                setSelectedFiles([file]);
                            }
                        },
                        onContextMenu: (e) => handleContextMenu(e, file),
                        onDoubleClick: () => {
                            if (!isFolder) {
                                downloadFile(file);
                            }
                        }
                    }, [
                        // Selection checkbox
                        React.createElement('input', {
                            key: 'checkbox',
                            type: 'checkbox',
                            checked: isSelected,
                            onChange: (e) => {
                                e.stopPropagation();
                                toggleFileSelection(file);
                            },
                            style: { cursor: 'pointer' }
                        }),

                        // File icon
                        React.createElement('div', {
                            key: 'icon',
                            style: { fontSize: viewMode === 'grid' ? '32px' : '24px' }
                        }, getFileIcon(file)),

                        // File info
                        React.createElement('div', {
                            key: 'info',
                            style: { flex: 1, minWidth: 0 }
                        }, [
                            React.createElement('p', {
                                key: 'name',
                                style: {
                                    color: 'white',
                                    margin: 0,
                                    fontSize: viewMode === 'grid' ? '16px' : '14px',
                                    fontWeight: '500',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap'
                                }
                            }, file.name),
                            React.createElement('p', {
                                key: 'details',
                                style: {
                                    color: 'rgba(255, 255, 255, 0.7)',
                                    margin: 0,
                                    fontSize: '12px',
                                    marginTop: '4px'
                                }
                            }, isFolder ? 'Folder' : `File${file.size ? ` • ${(file.size / 1024).toFixed(1)} KB` : ''}`)
                        ]),

                        // Action buttons
                        !isFolder && React.createElement('div', {
                            key: 'actions',
                            style: { display: 'flex', gap: '8px' }
                        }, [
                            React.createElement('button', {
                                key: 'download',
                                onClick: (e) => {
                                    e.stopPropagation();
                                    downloadFile(file);
                                },
                                style: {
                                    background: 'rgba(34, 197, 94, 0.2)',
                                    border: '1px solid rgba(34, 197, 94, 0.5)',
                                    borderRadius: '6px',
                                    color: 'white',
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                    fontSize: '12px',
                                    outline: 'none'
                                }
                            }, '⬇️')
                        ])
                    ]);
                })))
            ])),

            // Upload Modal
            showUploadModal && React.createElement('div', {
                key: 'uploadmodal',
                style: {
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0, 0, 0, 0.8)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 1000
                },
                onClick: (e) => {
                    if (e.target === e.currentTarget) {
                        setShowUploadModal(false);
                    }
                }
            }, React.createElement('div', {
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '20px',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    padding: '40px',
                    width: '90%',
                    maxWidth: '500px',
                    color: 'white'
                }
            }, [
                React.createElement('h3', {
                    key: 'title',
                    style: { margin: '0 0 24px 0', fontSize: '24px', fontWeight: 'bold' }
                }, 'Upload Files'),

                React.createElement('div', {
                    key: 'dropzone',
                    style: {
                        border: '2px dashed rgba(255, 255, 255, 0.3)',
                        borderRadius: '12px',
                        padding: '40px',
                        textAlign: 'center',
                        marginBottom: '24px',
                        background: 'rgba(255, 255, 255, 0.05)'
                    },
                    onDragOver: handleDragOver,
                    onDrop: (e) => {
                        handleDrop(e);
                        setShowUploadModal(false);
                    }
                }, [
                    React.createElement('div', {
                        key: 'icon',
                        style: { fontSize: '48px', marginBottom: '16px' }
                    }, '📤'),
                    React.createElement('p', {
                        key: 'text',
                        style: { margin: '0 0 16px 0', fontSize: '18px' }
                    }, 'Drag and drop files here'),
                    React.createElement('p', {
                        key: 'or',
                        style: { margin: '0 0 16px 0', color: 'rgba(255, 255, 255, 0.7)' }
                    }, 'or'),
                    React.createElement('input', {
                        key: 'fileinput',
                        type: 'file',
                        multiple: true,
                        onChange: (e) => {
                            if (e.target.files.length > 0) {
                                handleFileUpload(e.target.files);
                            }
                        },
                        style: { display: 'none' },
                        id: 'fileInput'
                    }),
                    React.createElement('label', {
                        key: 'label',
                        htmlFor: 'fileInput',
                        style: {
                            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                            border: 'none',
                            borderRadius: '8px',
                            color: 'white',
                            padding: '12px 24px',
                            cursor: 'pointer',
                            fontSize: '16px',
                            fontWeight: '500',
                            display: 'inline-block'
                        }
                    }, 'Choose Files')
                ]),

                React.createElement('div', {
                    key: 'actions',
                    style: { display: 'flex', justifyContent: 'flex-end', gap: '12px' }
                }, [
                    React.createElement('button', {
                        key: 'cancel',
                        onClick: () => setShowUploadModal(false),
                        style: {
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            color: 'white',
                            padding: '10px 20px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            outline: 'none'
                        }
                    }, 'Cancel')
                ])
            ])),

            // Context Menu
            contextMenu && React.createElement('div', {
                key: 'context-menu',
                style: {
                    position: 'fixed',
                    left: contextMenu.x,
                    top: contextMenu.y,
                    background: 'rgba(0, 0, 0, 0.9)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '8px',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    boxShadow: '0 10px 25px rgba(0, 0, 0, 0.3)',
                    zIndex: 1000,
                    minWidth: '180px',
                    overflow: 'hidden'
                },
                onClick: (e) => e.stopPropagation()
            }, [
                // Show copy/cut options only if not empty area
                !contextMenu.isEmptyArea && React.createElement('div', {
                    key: 'copy',
                    onClick: handleCopy,
                    style: {
                        padding: '12px 16px',
                        cursor: 'pointer',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                        color: 'white',
                        fontSize: '14px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                    },
                    onMouseEnter: (e) => e.target.style.background = 'rgba(255, 255, 255, 0.1)',
                    onMouseLeave: (e) => e.target.style.background = 'transparent'
                }, ['📋', ' Copy']),

                !contextMenu.isEmptyArea && React.createElement('div', {
                    key: 'cut',
                    onClick: handleCut,
                    style: {
                        padding: '12px 16px',
                        cursor: 'pointer',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                        color: 'white',
                        fontSize: '14px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                    },
                    onMouseEnter: (e) => e.target.style.background = 'rgba(255, 255, 255, 0.1)',
                    onMouseLeave: (e) => e.target.style.background = 'transparent'
                }, ['✂️', ' Cut']),

                clipboard.items.length > 0 && React.createElement('div', {
                    key: 'paste',
                    onClick: handlePaste,
                    style: {
                        padding: '12px 16px',
                        cursor: 'pointer',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                        color: 'white',
                        fontSize: '14px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                    },
                    onMouseEnter: (e) => e.target.style.background = 'rgba(255, 255, 255, 0.1)',
                    onMouseLeave: (e) => e.target.style.background = 'transparent'
                }, ['📋', ' Paste']),

                !contextMenu.isEmptyArea && React.createElement('div', {
                    key: 'rename',
                    onClick: handleRename,
                    style: {
                        padding: '12px 16px',
                        cursor: 'pointer',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                        color: 'white',
                        fontSize: '14px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                    },
                    onMouseEnter: (e) => e.target.style.background = 'rgba(255, 255, 255, 0.1)',
                    onMouseLeave: (e) => e.target.style.background = 'transparent'
                }, ['✏️', ' Rename']),

                !contextMenu.isEmptyArea && !contextMenu.file?.isDirectory && React.createElement('div', {
                    key: 'download',
                    onClick: () => {
                        downloadFile(contextMenu.file);
                        closeContextMenu();
                    },
                    style: {
                        padding: '12px 16px',
                        cursor: 'pointer',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                        color: 'white',
                        fontSize: '14px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                    },
                    onMouseEnter: (e) => e.target.style.background = 'rgba(255, 255, 255, 0.1)',
                    onMouseLeave: (e) => e.target.style.background = 'transparent'
                }, ['⬇️', ' Download']),

                !contextMenu.isEmptyArea && React.createElement('div', {
                    key: 'delete',
                    onClick: handleDeleteFromContext,
                    style: {
                        padding: '12px 16px',
                        cursor: 'pointer',
                        color: '#ef4444',
                        fontSize: '14px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                    },
                    onMouseEnter: (e) => e.target.style.background = 'rgba(239, 68, 68, 0.1)',
                    onMouseLeave: (e) => e.target.style.background = 'transparent'
                }, ['🗑️', ' Delete'])
            ])
        ]);
    };

    // Main App Component
    const App = () => {
        const [user, setUser] = React.useState(null);
        const [token, setToken] = React.useState(localStorage.getItem('token'));
        const [isLoading, setIsLoading] = React.useState(true);

        React.useEffect(() => {
            const initializeAuth = async () => {
                const storedToken = localStorage.getItem('token');

                if (storedToken) {
                    try {
                        const response = await fetch('/api/files/', {
                            headers: { 'Authorization': `Bearer ${storedToken}` }
                        });

                        if (response.ok) {
                            setUser({ id: 1, username: 'admin', role: 'admin' });
                            setToken(storedToken);
                        } else {
                            localStorage.removeItem('token');
                            setToken(null);
                            setUser(null);
                        }
                    } catch (error) {
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
            return React.createElement('div', {
                style: {
                    minHeight: '100vh',
                    background: 'linear-gradient(135deg, #2c3e50 0%, #34495e 25%, #5dade2 50%, #85c1e9 75%, #aed6f1 100%)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }
            }, React.createElement('div', {
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '20px',
                    padding: '40px',
                    textAlign: 'center',
                    border: '1px solid rgba(255, 255, 255, 0.2)'
                }
            }, [
                React.createElement('div', {
                    key: 'spinner',
                    style: {
                        width: '60px',
                        height: '60px',
                        border: '4px solid rgba(255, 255, 255, 0.3)',
                        borderTop: '4px solid white',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite',
                        margin: '0 auto 20px'
                    }
                }),
                React.createElement('p', {
                    key: 'text',
                    style: { color: 'white', margin: 0, fontSize: '18px' }
                }, 'Initializing futuristic file manager...')
            ]));
        }

        if (!token || !user) {
            return React.createElement(LoginForm, { onLogin: handleLogin });
        }

        return React.createElement(FileBrowser, { token: token, user: user });
    };

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

    // Render the app
    try {
        console.log('App: Rendering...');
        ReactDOM.render(React.createElement(App), document.getElementById('root'));
        console.log('App: Rendered successfully!');
    } catch (error) {
        console.error('App: Render failed:', error);
        document.getElementById('root').innerHTML = `
            <div style="
                min-height: 100vh;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                text-align: center;
                padding: 20px;
            ">
                <div style="
                    background: rgba(255, 255, 255, 0.1);
                    backdrop-filter: blur(20px);
                    border-radius: 20px;
                    padding: 40px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                ">
                    <h2 style="margin: 0 0 16px 0; color: #ef4444;">❌ Render Failed</h2>
                    <p style="margin: 0; opacity: 0.8;">Error: ${error.message}</p>
                </div>
            </div>
        `;
    }
}
