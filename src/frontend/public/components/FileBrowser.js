const FileBrowser = ({ token, user }) => {
    const [files, setFiles] = React.useState([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState('');
    const [currentPath, setCurrentPath] = React.useState('');
    const [selectedFiles, setSelectedFiles] = React.useState([]);
    const [viewMode, setViewMode] = React.useState('grid');
    const [searchQuery, setSearchQuery] = React.useState('');
    const [showUploadModal, setShowUploadModal] = React.useState(false);
    const [uploadingFiles, setUploadingFiles] = React.useState([]);
    const [clipboard, setClipboard] = React.useState({ items: [], action: null });
    const [showChangePasswordModal, setShowChangePasswordModal] = React.useState(false);
    const [contextMenu, setContextMenu] = React.useState(null);
    const [newFolderName, setNewFolderName] = React.useState('');

    // Timeout ID for debouncing search
    const timeoutId = setTimeout(() => {}, 0);
    clearTimeout(timeoutId);

    // Handle clicks outside context menu
    const handleGlobalClick = () => {
        if (contextMenu) {
            setContextMenu(null);
        }
    };

    React.useEffect(() => {
        document.addEventListener('click', handleGlobalClick);
        return () => document.removeEventListener('click', handleGlobalClick);
    }, []);

    const fetchFiles = async (path = currentPath) => {
        try {
            setLoading(true);
            setError('');
            const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (!response.ok) throw new Error('Failed to fetch files');
            const data = await response.json();
            
            // Filter out files with null/undefined names
            const validFiles = data.files ? data.files.filter(f => f && f.name) : [];
            setFiles(validFiles);
            setCurrentPath(data.currentPath || '');
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const performSearch = async (query) => {
        if (!query.trim()) {
            fetchFiles();
            return;
        }
        
        try {
            setLoading(true);
            setError('');
            const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (!response.ok) throw new Error('Search failed');
            const data = await response.json();
            
            // Filter out files with null/undefined names
            const validFiles = data.files ? data.files.filter(f => f && f.name) : [];
            setFiles(validFiles);
            setCurrentPath('Search Results');
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const closeContextMenu = () => {
        setContextMenu(null);
    };

    const handleEmptyAreaContextMenu = (e) => {
        e.preventDefault();
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            isEmptyArea: true,
            file: null,
            selectedFiles: selectedFiles
        });
    };

    const navigateToFolder = (folderPath, folderName) => {
        setCurrentPath(folderPath);
        setSelectedFiles([]);
        fetchFiles(folderPath);
    };

    const navigateBack = () => {
        if (currentPath) {
            const parentPath = currentPath.split('/').slice(0, -1).join('/');
            setCurrentPath(parentPath);
            setSelectedFiles([]);
            fetchFiles(parentPath);
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
        const validFiles = files.filter(f => f && f.name);
        if (selectedFiles.length === validFiles.length && validFiles.length > 0) {
            setSelectedFiles([]);
        } else {
            setSelectedFiles(validFiles);
        }
    };

    const deleteSelectedFiles = async () => {
        if (selectedFiles.length === 0) return;
        
        const itemsToDelete = selectedFiles.map(file => ({
            name: file.name,
            isDirectory: file.isDirectory
        }));
        
        try {
            const response = await fetch('/api/delete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    items: itemsToDelete,
                    path: currentPath
                })
            });
            
            if (response.ok) {
                fetchFiles();
                setSelectedFiles([]);
            } else {
                const data = await response.json();
                setError(data.error || 'Failed to delete files');
            }
        } catch (err) {
            setError('Connection error');
        }
    };

    const downloadFile = async (file) => {
        try {
            const response = await fetch(`/api/download?path=${encodeURIComponent(file.path)}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = file.name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            } else {
                const data = await response.json();
                setError(data.error || 'Download failed');
            }
        } catch (err) {
            setError('Download failed');
        }
    };

    const createNewFolder = async () => {
        if (!newFolderName.trim()) {
            setError('Folder name cannot be empty');
            return;
        }
        
        try {
            const response = await fetch('/api/create-folder', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    path: currentPath,
                    folderName: newFolderName
                })
            });
            
            if (response.ok) {
                fetchFiles();
                setNewFolderName('');
                setShowChangePasswordModal(false); // Use this to close the new folder modal
            } else {
                const data = await response.json();
                setError(data.error || 'Failed to create folder');
            }
        } catch (err) {
            setError('Connection error');
        }
    };

    const handleRefresh = async () => {
        fetchFiles();
        setSelectedFiles([]);
    };

    const handleFileUpload = async (uploadingFiles) => {
        if (uploadingFiles.length === 0) return;
        
        const formData = new FormData();
        uploadingFiles.forEach(file => {
            formData.append('files', file);
        });
        formData.append('path', currentPath);
        
        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (response.ok) {
                fetchFiles();
                setShowUploadModal(false);
                setUploadingFiles([]);
            } else {
                const data = await response.json();
                setError(data.error || 'Upload failed');
            }
        } catch (err) {
            setError('Upload failed');
        }
    };

    const handleDragOver = (e) => {
        e.preventDefault();
    };

    const handleDrop = (e) => {
        e.preventDefault();
        const droppedFiles = Array.from(e.dataTransfer.files);
        if (droppedFiles.length > 0) {
            setUploadingFiles(droppedFiles);
            setShowUploadModal(true);
        }
    };

    // Filter files based on search query
    const validFilteredFiles = files.filter(file => file && file.name);
    const filteredFiles = searchQuery 
        ? validFilteredFiles.filter(file => 
            file.name.toLowerCase().includes(searchQuery.toLowerCase())
        )
        : validFilteredFiles;

    const getFileIcon = (file) => {
        if (file.isDirectory) return '📁';
        const ext = file.name.split('.').pop().toLowerCase();
        const iconMap = {
            'pdf': '📄', 'txt': '📝', 'doc': '📄', 'docx': '📄',
            'xls': '📊', 'xlsx': '📊', 'ppt': '📽️', 'pptx': '📽️',
            'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️',
            'mp4': '🎬', 'avi': '🎬', 'mov': '🎬',
            'mp3': '🎵', 'wav': '🎵', 'flac': '🎵',
            'zip': '📦', 'rar': '📦', 'tar': '📦', 'gz': '📦',
            'js': '📜', 'ts': '📜', 'jsx': '📜', 'tsx': '📜',
            'py': '🐍', 'java': '☕', 'cpp': '📝', 'c': '📝',
            'html': '🌐', 'css': '🎨', 'json': '📋', 'xml': '📋',
            'sql': '🗄️', 'db': '🗄️'
        };
        return iconMap[ext] || '📄';
    };

    const handleContextMenu = (e, file) => {
        e.preventDefault();
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            isEmptyArea: false,
            file: file,
            selectedFiles: selectedFiles
        });
    };

    const handleCopy = () => {
        setClipboard({
            items: contextMenu.selectedFiles,
            action: 'copy'
        });
        closeContextMenu();
    };

    const handleCut = () => {
        setClipboard({
            items: contextMenu.selectedFiles,
            action: 'cut'
        });
        closeContextMenu();
    };

    const handlePaste = async () => {
        if (clipboard.items.length === 0) return;

        try {
            const response = await fetch('/api/paste', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    items: clipboard.items,
                    destinationPath: currentPath,
                    action: clipboard.action
                })
            });

            if (response.ok) {
                fetchFiles();
                setClipboard({ items: [], action: null });
            } else {
                const data = await response.json();
                setError(data.error || 'Paste failed');
            }
        } catch (err) {
            setError('Paste failed');
        }
        closeContextMenu();
    };

    const handleRename = () => {
        // Context menu will have the single file to rename
        const fileToRename = contextMenu.file;
        if (!fileToRename) {
            closeContextMenu();
            return;
        }
        
        const newName = prompt('Enter new name:', fileToRename.name);
        if (newName && newName !== fileToRename.name) {
            renameFile(fileToRename, newName);
        }
        closeContextMenu();
    };

    const handleDeleteFromContext = () => {
        if (contextMenu.isEmptyArea) {
            if (selectedFiles.length > 0) {
                // Delete selected files
                deleteSelectedFiles();
            }
        } else {
            // Delete single file
            if (contextMenu.file) {
                // Create a temporary selectedFiles array with just this file
                const originalSelectedFiles = [contextMenu.file];
                const itemsToDelete = originalSelectedFiles.map(file => ({
                    name: file.name,
                    isDirectory: file.isDirectory
                }));
                
                fetch('/api/delete', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        items: itemsToDelete,
                        path: currentPath
                    })
                })
                .then(response => {
                    if (response.ok) {
                        fetchFiles();
                        setSelectedFiles([]);
                    } else {
                        return response.json().then(data => {
                            throw new Error(data.error || 'Failed to delete file');
                        });
                    }
                })
                .catch(err => {
                    setError(err.message);
                });
            }
        }
        closeContextMenu();
    };

    const renameFile = async (file, newName) => {
        try {
            const response = await fetch('/api/rename', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    oldPath: file.path,
                    newPath: file.path.replace(file.name, newName),
                    newName: newName
                })
            });

            if (response.ok) {
                fetchFiles();
            } else {
                const data = await response.json();
                setError(data.error || 'Failed to rename file');
            }
        } catch (err) {
            setError('Rename failed');
        }
    };

    const handleChangePassword = async () => {
        // Implementation for changing password would go here
        // This is part of the change password modal functionality
        closeContextMenu();
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        window.location.reload();
    };

    const renderFileItem = (file, index) => {
        const isSelected = selectedFiles.some(f => f.path === file.path);
        const isFolder = file.isDirectory;

        return React.createElement('div', {
            key: file.path || index,
            style: {
                background: isSelected ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                border: isSelected ? '2px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: viewMode === 'grid' ? '16px' : '12px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: '12px'
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
                if (isFolder) {
                    navigateToFolder(file.path, file.name);
                } else {
                    downloadFile(file);
                }
            }
        }, [
            React.createElement('span', {
                style: { fontSize: '24px' }
            }, getFileIcon(file)),
            React.createElement('div', {
                style: { 
                    flex: 1, 
                    minWidth: 0 
                }
            }, [
                React.createElement('div', {
                    style: { 
                        color: 'white', 
                        fontWeight: '500',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                    }
                }, file.name),
                React.createElement('div', {
                    style: { 
                        fontSize: '12px', 
                        color: 'rgba(255, 255, 255, 0.6)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                    }
                }, isFolder ? 'Folder' : `${(file.size || 0).toLocaleString()} bytes`)
            ])
        ]);
    };

    const fileItems = filteredFiles.map((file, index) => renderFileItem(file, index));

    return React.createElement('div', {
        style: {
            height: '100vh',
            background: 'linear-gradient(135deg, #1e3a8a, #0f172a)',
            color: 'white',
            fontFamily: 'Arial, sans-serif',
            display: 'flex',
            flexDirection: 'column'
        }
    }, [
        // Navigation Bar
        React.createElement('div', {
            key: 'navbar',
            style: {
                padding: '16px',
                background: 'rgba(0, 0, 0, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
            }
        }, [
            React.createElement('div', {
                style: { display: 'flex', alignItems: 'center', gap: '16px' }
            }, [
                React.createElement('button', {
                    onClick: navigateBack,
                    disabled: !currentPath,
                    style: {
                        background: 'rgba(255, 255, 255, 0.1)',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '8px 12px',
                        color: 'white',
                        cursor: currentPath ? 'pointer' : 'not-allowed',
                        opacity: currentPath ? 1 : 0.5
                    }
                }, '← Back'),
                React.createElement('div', {
                    style: {
                        fontSize: '14px',
                        color: 'rgba(255, 255, 255, 0.8)',
                        maxWidth: '300px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                    }
                }, currentPath || '/'),
            ]),
            React.createElement('div', {
                style: { display: 'flex', alignItems: 'center', gap: '12px' }
            }, [
                React.createElement('span', {
                    style: { 
                        fontSize: '14px', 
                        color: 'rgba(255, 255, 255, 0.8)' 
                    }
                }, `Hello, ${user?.username || 'User'}`),
                React.createElement('button', {
                    onClick: handleLogout,
                    style: {
                        background: 'rgba(239, 68, 68, 0.2)',
                        border: '1px solid rgba(239, 68, 68, 0.5)',
                        borderRadius: '6px',
                        padding: '8px 12px',
                        color: '#ef4444',
                        cursor: 'pointer',
                        fontSize: '14px'
                    }
                }, 'Logout')
            ])
        ]),

        // Toolbar
        React.createElement('div', {
            key: 'toolbar',
            style: {
                padding: '16px',
                background: 'rgba(0, 0, 0, 0.1)',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
            }
        }, [
            React.createElement('input', {
                type: 'text',
                placeholder: 'Search files...',
                value: searchQuery,
                onChange: (e) => {
                    setSearchQuery(e.target.value);
                    // Debounce search
                    clearTimeout(timeoutId);
                    setTimeout(() => performSearch(e.target.value), 300);
                },
                style: {
                    flex: 1,
                    padding: '10px 16px',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '8px',
                    background: 'rgba(255, 255, 255, 0.05)',
                    color: 'white',
                    fontSize: '14px'
                }
            }),
            React.createElement('button', {
                onClick: () => setViewMode(viewMode === 'grid' ? 'list' : 'grid'),
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '10px',
                    color: 'white',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }
            }, viewMode === 'grid' ? '📊' : '📝'),
            React.createElement('button', {
                onClick: handleRefresh,
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '10px',
                    color: 'white',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }
            }, '🔄'),
            React.createElement('button', {
                onClick: () => setShowUploadModal(true),
                style: {
                    background: 'linear-gradient(135deg, #10b981, #059669)',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '10px 16px',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                }
            }, ['📤', ' Upload']),
            React.createElement('button', {
                onClick: () => {
                    setNewFolderName('');
                    setShowChangePasswordModal(true); // Repurposed for new folder
                },
                style: {
                    background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '10px 16px',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                }
            }, ['📁', ' New Folder']),
            selectedFiles.length > 0 && React.createElement('button', {
                onClick: deleteSelectedFiles,
                key: 'delete-selected',
                style: {
                    background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '10px 16px',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                }
            }, ['🗑️', ` Delete (${selectedFiles.length})`]),
            clipboard.items.length > 0 && React.createElement('button', {
                onClick: handlePaste,
                key: 'paste',
                style: {
                    background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '10px 16px',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                }
            }, ['📋', ` Paste (${clipboard.items.length})`])
        ]),

        // File Browser Content
        React.createElement('div', {
            key: 'content',
            style: {
                flex: 1,
                padding: '16px',
                overflow: 'auto',
                position: 'relative'
            },
            onDragOver: handleDragOver,
            onDrop: handleDrop,
            onContextMenu: handleEmptyAreaContextMenu
        }, [
            // Show upload area if drag and drop
            // Additional UI elements can be placed here
            
            error ? React.createElement('div', {
                key: 'error',
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
            ]) : validFilteredFiles.length === 0 ? React.createElement('div', {
                key: 'empty',
                style: {
                    textAlign: 'center',
                    padding: '40px',
                    color: 'rgba(255, 255, 255, 0.6)'
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
                    key: 'clear-search',
                    onClick: () => setSearchQuery(''),
                    style: {
                        background: 'rgba(59, 130, 246, 0.2)',
                        border: '1px solid rgba(59, 130, 246, 0.5)',
                        borderRadius: '8px',
                        padding: '10px 16px',
                        color: 'white',
                        cursor: 'pointer',
                        fontSize: '14px',
                        marginTop: '16px'
                    }
                }, 'Clear Search')
            ]) : React.createElement('div', {
                key: 'files-container',
                style: viewMode === 'grid' ? {
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: '16px'
                } : {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                }
            }, fileItems)
        ]),

        // Upload Modal
        showUploadModal && React.createElement('div', {
            key: 'upload-modal',
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
            }
        }, [
            React.createElement('div', {
                style: {
                    background: 'rgba(30, 30, 30, 0.9)',
                    borderRadius: '12px',
                    padding: '32px',
                    width: '500px',
                    maxWidth: '90%',
                    boxShadow: '0 20px 25px rgba(0, 0, 0, 0.5)'
                }
            }, [
                React.createElement('h2', {
                    style: { 
                        color: 'white', 
                        margin: '0 0 24px 0',
                        fontSize: '22px',
                        textAlign: 'center'
                    }
                }, 'Upload Files'),
                
                React.createElement('div', {
                    style: {
                        marginBottom: '24px'
                    }
                }, [
                    React.createElement('p', {
                        style: {
                            color: 'rgba(255, 255, 255, 0.8)',
                            margin: '0 0 12px 0',
                            fontSize: '16px'
                        }
                    }, `Current folder: ${currentPath || '/'}`),
                    
                    React.createElement('input', {
                        type: 'file',
                        multiple: true,
                        onChange: (e) => {
                            setUploadingFiles(Array.from(e.target.files));
                        },
                        style: {
                            width: '100%',
                            padding: '12px',
                            border: '2px dashed rgba(255, 255, 255, 0.3)',
                            borderRadius: '8px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'white'
                        }
                    })
                ]),
                
                uploadingFiles.length > 0 && React.createElement('div', {
                    style: {
                        marginBottom: '24px',
                        maxHeight: '200px',
                        overflowY: 'auto'
                    }
                }, [
                    React.createElement('h3', {
                        style: { 
                            color: 'white', 
                            margin: '0 0 12px 0',
                            fontSize: '16px'
                        }
                    }, `Files to upload (${uploadingFiles.length}):`),
                    
                    React.createElement('ul', {
                        style: {
                            listStyle: 'none',
                            padding: 0,
                            margin: 0
                        }
                    }, uploadingFiles.map((file, index) => 
                        React.createElement('li', {
                            key: index,
                            style: {
                                padding: '8px',
                                background: 'rgba(255, 255, 255, 0.1)',
                                borderRadius: '4px',
                                marginBottom: '4px',
                                fontSize: '14px',
                                color: 'rgba(255, 255, 255, 0.9)'
                            }
                        }, [
                            React.createElement('span', {
                                style: { display: 'inline-block', width: '24px' }
                            }, '📄'),
                            file.name
                        ])
                    ))
                ]),
                
                React.createElement('div', {
                    style: {
                        display: 'flex',
                        gap: '12px'
                    }
                }, [
                    React.createElement('button', {
                        onClick: () => setShowUploadModal(false),
                        style: {
                            flex: 1,
                            padding: '12px',
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px'
                        }
                    }, 'Cancel'),
                    
                    React.createElement('button', {
                        onClick: () => handleFileUpload(uploadingFiles),
                        style: {
                            flex: 1,
                            padding: '12px',
                            background: 'linear-gradient(135deg, #10b981, #059669)',
                            border: 'none',
                            borderRadius: '8px',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px'
                        }
                    }, `Upload (${uploadingFiles.length})`)
                ])
            ])
        ]),

        // New Folder Modal (using change password modal)
        showChangePasswordModal && !newFolderName && React.createElement('div', {
            key: 'new-folder-modal',
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
            }
        }, [
            React.createElement('div', {
                style: {
                    background: 'rgba(30, 30, 30, 0.9)',
                    borderRadius: '12px',
                    padding: '32px',
                    width: '400px',
                    maxWidth: '90%',
                    boxShadow: '0 20px 25px rgba(0, 0, 0, 0.5)'
                }
            }, [
                React.createElement('h2', {
                    style: { 
                        color: 'white', 
                        margin: '0 0 24px 0',
                        fontSize: '22px',
                        textAlign: 'center'
                    }
                }, 'Create New Folder'),
                
                React.createElement('input', {
                    type: 'text',
                    placeholder: 'Folder name',
                    value: newFolderName,
                    onChange: (e) => setNewFolderName(e.target.value),
                    onKeyPress: (e) => {
                        if (e.key === 'Enter') {
                            createNewFolder();
                        }
                    },
                    style: {
                        width: '100%',
                        padding: '14px',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '8px',
                        background: 'rgba(255, 255, 255, 0.05)',
                        color: 'white',
                        fontSize: '16px',
                        marginBottom: '16px'
                    }
                }),
                
                error && React.createElement('div', {
                    key: 'folder-error',
                    style: { 
                        color: '#ef4444', 
                        textAlign: 'center',
                        padding: '12px',
                        background: 'rgba(239, 68, 68, 0.1)',
                        borderRadius: '8px',
                        marginBottom: '16px'
                    }
                }, error),
                
                React.createElement('div', {
                    style: {
                        display: 'flex',
                        gap: '12px'
                    }
                }, [
                    React.createElement('button', {
                        onClick: () => {
                            setShowChangePasswordModal(false);
                            setNewFolderName('');
                            setError('');
                        },
                        style: {
                            flex: 1,
                            padding: '12px',
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px'
                        }
                    }, 'Cancel'),
                    
                    React.createElement('button', {
                        onClick: createNewFolder,
                        style: {
                            flex: 1,
                            padding: '12px',
                            background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
                            border: 'none',
                            borderRadius: '8px',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px'
                        }
                    }, 'Create')
                ])
            ])
        ]),

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

            !contextMenu.isEmptyArea && contextMenu.file && !contextMenu.file.isDirectory && React.createElement('div', {
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

// Export for use in main app
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FileBrowser };
}