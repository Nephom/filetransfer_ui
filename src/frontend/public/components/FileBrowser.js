// Make FileBrowser component available globally (must be before the component definition)
if (!window.FileTransferApp) {
    window.FileTransferApp = {};
}

const FileBrowser = ({ token, user }) => {
    const [files, setFiles] = React.useState([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState('');
    const [currentPath, setCurrentPath] = React.useState('');
    const [displayPath, setDisplayPath] = React.useState('');
    const [selectedFiles, setSelectedFiles] = React.useState([]);
    const [viewMode, setViewMode] = React.useState('grid');
    const [searchQuery, setSearchQuery] = React.useState('');
    const [isSearching, setIsSearching] = React.useState(false);
    const [pathBeforeSearch, setPathBeforeSearch] = React.useState('');
    const [showUploadModal, setShowUploadModal] = React.useState(false);
    const [uploadingFiles, setUploadingFiles] = React.useState([]);
    const [clipboard, setClipboard] = React.useState({ items: [], action: null });
    const [showNewFolderModal, setShowNewFolderModal] = React.useState(false);
    const [newFolderName, setNewFolderName] = React.useState('');
    const [showUserDropdown, setShowUserDropdown] = React.useState(false);
    const [showChangePasswordModal, setShowChangePasswordModal] = React.useState(false);
    const [isDragging, setIsDragging] = React.useState(false);
    const [showActionsDropdown, setShowActionsDropdown] = React.useState(false);
    const [showRenameModal, setShowRenameModal] = React.useState(false);
    const [renameTarget, setRenameTarget] = React.useState(null);
    const [newName, setNewName] = React.useState('');
    const [uploadProgress, setUploadProgress] = React.useState(0);
    const [isUploading, setIsUploading] = React.useState(false);
    const [uploadMode, setUploadMode] = React.useState('files'); // 'files' or 'folder'
    const [uploadBatchId, setUploadBatchId] = React.useState(null);
    const [uploadTransferId, setUploadTransferId] = React.useState(null);
    const [uploadDetails, setUploadDetails] = React.useState(null); // For batch upload details

    React.useEffect(() => {
        fetchFiles();
    }, []);

    const timeoutIdRef = React.useRef(null);

    // Handle clicks outside context menu and dropdown
    const handleGlobalClick = () => {
        if (showUserDropdown) {
            setShowUserDropdown(false);
        }
        if (showActionsDropdown) {
            setShowActionsDropdown(false);
        }
    };

    React.useEffect(() => {
        document.addEventListener('click', handleGlobalClick);
        return () => document.removeEventListener('click', handleGlobalClick);
    }, [showUserDropdown, showActionsDropdown]);

    const fetchFiles = async (path = currentPath) => {
        // When fetching files, clear the search query
        setSearchQuery('');
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
            const newPath = data.currentPath || '';
            setCurrentPath(newPath);
            setDisplayPath(newPath);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const performSearch = async (query) => {
        if (!query.trim()) {
            // Clear search and return to original path
            if (isSearching) {
                setIsSearching(false);
                fetchFiles(pathBeforeSearch);
            }
            return;
        }

        try {
            // Save current path before searching (only on first search)
            if (!isSearching) {
                setPathBeforeSearch(currentPath);
                setIsSearching(true);
            }

            setLoading(true);
            setError('');
            const response = await fetch(`/api/files/search?query=${encodeURIComponent(query)}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!response.ok) {
                if (response.status === 202) {
                    // Index is building
                    const data = await response.json();
                    setError(data.message || 'Search index is building. Please try again in a moment.');
                    setFiles([]);
                    setDisplayPath(`Search Results`);
                    return;
                }
                throw new Error('Search failed');
            }

            const searchResults = await response.json();

            // Handle indexing status
            if (searchResults.indexing) {
                setError(searchResults.message || 'Search index is building. Please try again later.');
                setFiles([]);
                setDisplayPath(`Search Results`);
                return;
            }

            // Set search results - only update displayPath, keep currentPath unchanged
            setFiles(searchResults.files || []);
            setDisplayPath(`Search Results (${searchResults.resultCount || 0} found)`);

            // Clear any previous errors
            setError('');
        } catch (err) {
            setError(err.message || 'Search failed');
            setFiles([]);
        } finally {
            setLoading(false);
        }
    };



    const navigateToFolder = (folderPath, folderName) => {
        // Exit search mode when navigating to a folder
        setIsSearching(false);
        setSearchQuery('');
        setSelectedFiles([]);
        setError(''); // Clear any errors
        fetchFiles(folderPath);
    };

    const navigateBack = () => {
        if (isSearching) {
            // If in search mode, clear search and restore original path
            setSearchQuery('');
            setIsSearching(false);
            fetchFiles(pathBeforeSearch);
        } else if (currentPath) {
            const parentPath = currentPath.split('/').slice(0, -1).join('/');
            setSelectedFiles([]);
            setError(''); // Clear any errors
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
            const response = await fetch('/api/files/delete', {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    items: itemsToDelete,
                    currentPath: currentPath
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
            const response = await fetch(`/api/files/download/${encodeURIComponent(file.path)}`, {
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

    const handleDownload = () => {
        if (selectedFiles.length === 1 && !selectedFiles[0].isDirectory) {
            downloadFile(selectedFiles[0]);
        } else if (selectedFiles.length > 0) {
            downloadArchive(selectedFiles);
        }
    };

    const downloadArchive = async (files) => {
        try {
            const response = await fetch('/api/archive', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    items: files.map(f => ({
                        name: f.name,
                        isDirectory: f.isDirectory
                    })),
                    currentPath: currentPath
                })
            });

            if (response.ok) {
                const blob = await response.blob();
                const disposition = response.headers.get('Content-Disposition') || '';
                let filename = 'archive.zip';

                const match = disposition.match(/filename="?([^";]+)"?/i);
                if (match && match[1]) {
                    filename = decodeURIComponent(match[1]);
                }

                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            } else {
                const data = await response.json();
                setError(data.error || 'Archive download failed');
            }
        } catch (err) {
            setError('Archive download failed');
        }
    };

    const createNewFolder = async () => {
        if (!newFolderName.trim()) {
            setError('Folder name cannot be empty');
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
                    folderName: newFolderName,
                    currentPath: currentPath
                })
            });

            if (response.ok) {
                fetchFiles();
                setNewFolderName('');
                setShowNewFolderModal(false);
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

        // Check if files have webkitRelativePath (folder upload)
        const hasFolderStructure = uploadingFiles.some(file => file.webkitRelativePath);

        try {
            setIsUploading(true);
            setUploadProgress(0);
            setUploadDetails(null);
            setError('');

            // Single file upload: use /api/upload/single-progress
            if (uploadingFiles.length === 1 && !hasFolderStructure) {
                await handleSingleFileUpload(uploadingFiles[0]);
            }
            // Multi-file upload: use /api/upload/multiple with batch tracking
            else {
                await handleMultiFileUpload(uploadingFiles, hasFolderStructure);
            }

        } catch (err) {
            setIsUploading(false);
            setUploadProgress(0);
            setError(err.message || 'Upload failed');
        }
    };

    // Handle single file upload with real-time progress
    const handleSingleFileUpload = async (file) => {
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('fileName', file.name);
            if (currentPath) {
                formData.append('path', currentPath);
            }

            // Initiate upload
            const response = await fetch('/api/upload/single-progress', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                body: formData
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error?.message || 'Upload initiation failed');
            }

            const { transferId } = await response.json();
            setUploadTransferId(transferId);

            // Start polling for progress
            pollSingleProgress(transferId);

        } catch (error) {
            throw error;
        }
    };

    // Handle multi-file upload with batch tracking
    const handleMultiFileUpload = async (uploadingFiles, hasFolderStructure) => {
        try {
            const formData = new FormData();

            uploadingFiles.forEach((file, index) => {
                formData.append('files', file);

                // If folder upload, preserve the relative path
                if (hasFolderStructure && file.webkitRelativePath) {
                    formData.append('filePaths[]', file.webkitRelativePath);
                }
            });

            formData.append('path', currentPath);

            // Initiate batch upload
            const response = await fetch('/api/upload/multiple', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                body: formData
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error?.message || 'Batch upload initiation failed');
            }

            const { batchId } = await response.json();
            setUploadBatchId(batchId);

            // Start polling for batch progress
            pollBatchProgress(batchId);

        } catch (error) {
            throw error;
        }
    };

    // Poll single file progress
    const pollSingleProgress = async (transferId) => {
        const pollInterval = setInterval(async () => {
            try {
                const response = await fetch(`/api/progress/${transferId}`, {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });

                if (!response.ok) {
                    clearInterval(pollInterval);
                    setIsUploading(false);
                    setError('Failed to fetch progress');
                    return;
                }

                const progressData = await response.json();
                setUploadProgress(Math.round(progressData.progress || 0));

                // Check if completed or failed
                if (progressData.status === 'completed') {
                    clearInterval(pollInterval);
                    setIsUploading(false);
                    setUploadProgress(100);

                    // Show success message
                    alert(`✅ Upload completed! File uploaded successfully.`);

                    // Refresh file list
                    fetchFiles();

                    // Close upload modal and clear files
                    setShowUploadModal(false);
                    setUploadingFiles([]);
                    setUploadProgress(0);
                    setUploadTransferId(null);
                    setError('');
                } else if (progressData.status === 'failed') {
                    clearInterval(pollInterval);
                    setIsUploading(false);
                    setError(progressData.error || 'Upload failed');
                }

            } catch (error) {
                clearInterval(pollInterval);
                setIsUploading(false);
                setError('Failed to fetch progress');
            }
        }, 1000); // Poll every second
    };

    // Poll batch progress
    const pollBatchProgress = async (batchId) => {
        const pollInterval = setInterval(async () => {
            try {
                const response = await fetch(`/api/progress/batch/${batchId}`, {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });

                if (!response.ok) {
                    clearInterval(pollInterval);
                    setIsUploading(false);
                    setError('Failed to fetch batch progress');
                    return;
                }

                const batchData = await response.json();
                setUploadProgress(Math.round(batchData.progress || 0));
                setUploadDetails({
                    totalFiles: batchData.totalFiles,
                    successCount: batchData.successCount,
                    failedCount: batchData.failedCount,
                    files: batchData.files
                });

                // Check if batch is completed
                if (batchData.status === 'completed' || batchData.status === 'partial_fail' || batchData.status === 'failed') {
                    clearInterval(pollInterval);
                    setIsUploading(false);

                    if (batchData.status === 'completed') {
                        alert(`✅ Upload completed! ${batchData.successCount} file(s) uploaded successfully.`);
                    } else if (batchData.status === 'partial_fail') {
                        alert(`⚠️ Partial upload: ${batchData.successCount} succeeded, ${batchData.failedCount} failed.`);
                    } else {
                        alert(`❌ Upload failed: All ${batchData.failedCount} file(s) failed.`);
                    }

                    // Refresh file list
                    fetchFiles();

                    // Close upload modal and clear files
                    setShowUploadModal(false);
                    setUploadingFiles([]);
                    setUploadProgress(0);
                    setUploadBatchId(null);
                    setUploadDetails(null);
                    setError('');
                }

            } catch (error) {
                clearInterval(pollInterval);
                setIsUploading(false);
                setError('Failed to fetch batch progress');
            }
        }, 1000); // Poll every second
    };

    const handleDragEnter = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Only set isDragging to false if we're leaving the content area itself
        // Check if the related target is outside the content area
        if (e.currentTarget === e.target) {
            setIsDragging(false);
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        const droppedFiles = Array.from(e.dataTransfer.files);
        if (droppedFiles.length > 0) {
            setUploadingFiles(droppedFiles);
            setShowUploadModal(true);
        }
    };

    // The files state is now the single source of truth, populated by either fetchFiles or performSearch.
    const validFilteredFiles = files.filter(file => file && file.name);

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

    const handleChangePassword = async (oldPassword, newPassword) => {
        try {
            const response = await fetch('/auth/change-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    oldPassword: oldPassword,
                    newPassword: newPassword
                })
            });

            if (response.ok) {
                setShowChangePasswordModal(false);
                // You could show a success message here
            } else {
                const data = await response.json();
                setError(data.error || 'Failed to change password');
            }
        } catch (err) {
            setError('Connection error');
        }
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        window.location.reload();
    };

    // Copy selected files to clipboard
    const handleCopy = () => {
        if (selectedFiles.length === 0) {
            setError('Please select files to copy');
            return;
        }
        // Create a new array to avoid reference issues
        const copiedItems = selectedFiles.map(f => ({
            name: f.name,
            path: f.path,
            isDirectory: f.isDirectory,
            size: f.size
        }));
        setClipboard({ items: copiedItems, action: 'copy' });
        setShowActionsDropdown(false);
        console.log('Copied to clipboard:', copiedItems.length, 'items');
    };

    // Cut selected files to clipboard
    const handleCut = () => {
        if (selectedFiles.length === 0) {
            setError('Please select files to move');
            return;
        }
        // Create a new array to avoid reference issues
        const cutItems = selectedFiles.map(f => ({
            name: f.name,
            path: f.path,
            isDirectory: f.isDirectory,
            size: f.size
        }));
        setClipboard({ items: cutItems, action: 'cut' });
        setShowActionsDropdown(false);
        console.log('Cut to clipboard:', cutItems.length, 'items');
    };

    // Paste files from clipboard
    const handlePaste = async () => {
        if (clipboard.items.length === 0) {
            setError('No items in clipboard');
            return;
        }

        console.log('Pasting items:', clipboard.items);
        console.log('Paste operation:', clipboard.action);

        try {
            const response = await fetch('/api/files/paste', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    items: clipboard.items.map(f => ({
                        name: f.name,
                        path: f.path,  // Send relative path, backend will handle storagePath
                        isDirectory: f.isDirectory
                    })),
                    operation: clipboard.action,
                    targetPath: currentPath
                })
            });

            if (response.ok) {
                const data = await response.json();
                console.log('Paste successful:', data.message);

                // Always clear clipboard after successful paste (both copy and cut)
                // For copy operations, user needs to explicitly copy again if they want to paste again
                setClipboard({ items: [], action: null });

                // Refresh file list
                await fetchFiles();

                setShowActionsDropdown(false);
                setError('');
            } else {
                const data = await response.json();
                setError(data.error || 'Paste operation failed');
            }
        } catch (err) {
            console.error('Paste error:', err);
            setError('Paste operation failed');
        }
    };

    // Open rename modal
    const handleRenameClick = () => {
        if (selectedFiles.length !== 1) {
            setError('Please select exactly one file to rename');
            return;
        }
        setRenameTarget(selectedFiles[0]);
        setNewName(selectedFiles[0].name);
        setShowRenameModal(true);
        setShowActionsDropdown(false);
    };

    // Execute rename
    const executeRename = async () => {
        if (!newName.trim() || !renameTarget) {
            setError('New name cannot be empty');
            return;
        }

        try {
            const response = await fetch('/api/files/rename', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    oldName: renameTarget.name,
                    newName: newName.trim(),
                    currentPath: currentPath
                })
            });

            if (response.ok) {
                fetchFiles();
                setShowRenameModal(false);
                setRenameTarget(null);
                setNewName('');
                setSelectedFiles([]);
                setError('');
            } else {
                const data = await response.json();
                setError(data.error || 'Rename failed');
            }
        } catch (err) {
            setError('Rename failed');
        }
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

            onDoubleClick: () => {
                if (isFolder) {
                    navigateToFolder(file.path, file.name);
                } else {
                    // Temporarily disable double-click download as per user request to fix an error.
                    // A new download implementation is planned.
                    alert('下載功能正在更新中。請暫時使用右鍵選單中的下載選項。');
                }
            }
        }, [
            React.createElement('input', {
                key: `checkbox-${file.path || file.name}-${index}`,
                type: 'checkbox',
                checked: isSelected,
                onChange: () => toggleFileSelection(file),
                style: {
                    cursor: 'pointer',
                    margin: 0
                },
                onClick: (e) => e.stopPropagation() // Prevent checkbox click from triggering parent div click
            }),
            React.createElement('span', {
                key: 'file-icon-' + index,
                style: { fontSize: '24px' }
            }, getFileIcon(file)),
            React.createElement('div', {
                key: 'file-info-container-' + index,
                style: { 
                    flex: 1, 
                    minWidth: 0 
                }
            }, [
                React.createElement('div', {
                    key: 'file-name-' + index,
                    style: { 
                        color: 'white', 
                        fontWeight: '500',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                    }
                }, file.name),
                React.createElement('div', {
                    key: 'file-details-' + index,
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

    const fileItems = validFilteredFiles.map((file, index) => renderFileItem(file, index));

    return React.createElement('div', {
        style: {
            height: '100vh',
            background: 'linear-gradient(135deg, #2c3e50 0%, #34495e 25%, #5d6d7e 50%, #85929e 75%, #aeb6bf 100%)',
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
                background: 'rgba(44, 62, 80, 0.8)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid rgba(173, 181, 189, 0.2)'
            }
        }, [
            React.createElement('div', {
                key: 'navbar-left', // Add key for sibling element in array
                style: { display: 'flex', alignItems: 'center', gap: '16px' }
            }, [
                React.createElement('button', {
                    key: 'back-button',
                    onClick: navigateBack,
                    disabled: !currentPath && !searchQuery,
                    style: {
                        background: 'rgba(173, 181, 189, 0.2)',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '8px 12px',
                        color: 'white',
                        cursor: (currentPath || searchQuery) ? 'pointer' : 'not-allowed',
                        opacity: (currentPath || searchQuery) ? 1 : 0.5
                    }
                }, '← Back'),
                React.createElement('div', {
                    key: 'current-path',
                    style: {
                        fontSize: '14px',
                        color: 'rgba(248, 249, 250, 0.9)',
                        maxWidth: '300px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                    }
                }, displayPath || '/'),
            ]),
            React.createElement('div', {
                key: 'navbar-right', // Add key for sibling element in array
                style: { display: 'flex', alignItems: 'center', gap: '12px' }
            }, [
                React.createElement('span', {
                    key: 'username',
                    style: { 
                        fontSize: '14px', 
                        color: 'rgba(255, 255, 255, 0.8)' 
                    }
                }, `Hello, ${user?.username || 'User'}`),
                React.createElement('div', {
                    key: 'user-dropdown-container',
                    style: { position: 'relative' }
                }, [
                    React.createElement('button', {
                        key: 'user-dropdown-toggle',
                        onClick: (e) => {
                            e.stopPropagation();
                            setShowUserDropdown(!showUserDropdown);
                        },
                        style: {
                            background: 'rgba(59, 130, 246, 0.2)',
                            border: '1px solid rgba(59, 130, 246, 0.5)',
                            borderRadius: '6px',
                            padding: '8px 12px',
                            color: '#3b82f6',
                            cursor: 'pointer',
                            fontSize: '14px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }
                    }, [
                        React.createElement('span', { key: 'username-text' }, user?.username || 'User'),
                        React.createElement('span', { key: 'dropdown-arrow' }, ' ▼')
                    ]),
                    showUserDropdown && React.createElement('div', {
                        key: 'user-dropdown-menu',
                        style: {
                            position: 'absolute',
                            top: '100%',
                            right: 0,
                            marginTop: '4px',
                            background: 'rgba(0, 0, 0, 0.9)',
                            backdropFilter: 'blur(20px)',
                            borderRadius: '8px',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.3)',
                            zIndex: 1000,
                            minWidth: '180px',
                            overflow: 'hidden'
                        }
                    }, [
                        React.createElement('button', {
                            key: 'change-password-option',
                            onClick: () => {
                                setShowUserDropdown(false);
                                setShowChangePasswordModal(true);
                            },
                            style: {
                                width: '100%',
                                padding: '12px 16px',
                                background: 'transparent',
                                border: 'none',
                                color: 'white',
                                cursor: 'pointer',
                                fontSize: '14px',
                                textAlign: 'left',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
                            },
                            onMouseEnter: (e) => e.target.style.background = 'rgba(255, 255, 255, 0.1)',
                            onMouseLeave: (e) => e.target.style.background = 'transparent'
                        }, [
                            React.createElement('span', { key: 'password-icon' }, '🔐'),
                            React.createElement('span', { key: 'password-text' }, ' Change Password')
                        ]),
                        user?.username === 'admin' && React.createElement('button', {
                            key: 'admin-panel-option',
                            onClick: () => {
                                setShowUserDropdown(false);
                                window.location.href = '/admin.html';
                            },
                            style: {
                                width: '100%',
                                padding: '12px 16px',
                                background: 'transparent',
                                border: 'none',
                                color: 'white',
                                cursor: 'pointer',
                                fontSize: '14px',
                                textAlign: 'left',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
                            },
                            onMouseEnter: (e) => e.target.style.background = 'rgba(255, 255, 255, 0.1)',
                            onMouseLeave: (e) => e.target.style.background = 'transparent'
                        }, [
                            React.createElement('span', { key: 'admin-icon' }, '⚙️'),
                            React.createElement('span', { key: 'admin-text' }, ' Admin Panel')
                        ]),
                        React.createElement('button', {
                            key: 'logout-option',
                            onClick: () => {
                                setShowUserDropdown(false);
                                handleLogout();
                            },
                            style: {
                                width: '100%',
                                padding: '12px 16px',
                                background: 'transparent',
                                border: 'none',
                                color: '#ef4444',
                                cursor: 'pointer',
                                fontSize: '14px',
                                textAlign: 'left',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px'
                            },
                            onMouseEnter: (e) => e.target.style.background = 'rgba(239, 68, 68, 0.1)',
                            onMouseLeave: (e) => e.target.style.background = 'transparent'
                        }, [
                            React.createElement('span', { key: 'logout-icon' }, '🚪'),
                            React.createElement('span', { key: 'logout-text' }, ' Logout')
                        ])
                    ])
                ])
            ])
        ]),

        // Toolbar
        React.createElement('div', {
            key: 'toolbar',
            style: {
                padding: '16px',
                background: 'rgba(52, 73, 94, 0.6)',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                borderBottom: '1px solid rgba(173, 181, 189, 0.2)'
            }
        }, [
            React.createElement('input', {
                key: 'search-input',
                type: 'text',
                placeholder: 'Search files...',
                title: 'Search files and folders',
                value: searchQuery,
                onChange: (e) => {
                    const query = e.target.value;
                    setSearchQuery(query);
                    clearTimeout(timeoutIdRef.current);
                    timeoutIdRef.current = setTimeout(() => {
                        performSearch(query);
                    }, 300);
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
                key: 'view-mode-button',
                title: 'Toggle view mode',
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
                key: 'refresh-button',
                title: 'Refresh',
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
                key: 'upload-button',
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
            }, [
                React.createElement('span', { key: 'upload-icon' }, '📤'),
                React.createElement('span', { key: 'upload-text' }, ' Upload')
            ]),
            React.createElement('div', {
                key: 'actions-dropdown-container',
                style: { position: 'relative' }
            }, [
                React.createElement('button', {
                    key: 'actions-dropdown-toggle',
                    onClick: (e) => {
                        e.stopPropagation();
                        setShowActionsDropdown(!showActionsDropdown);
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
                        gap: '6px',
                        transition: 'all 0.3s ease'
                    }
                }, [
                    React.createElement('span', { key: 'actions-icon' }, '⚡'),
                    React.createElement('span', { key: 'actions-text' }, 'Actions'),
                    React.createElement('span', {
                        key: 'dropdown-arrow',
                        style: {
                            transition: 'transform 0.3s ease',
                            transform: showActionsDropdown ? 'rotate(180deg)' : 'rotate(0deg)'
                        }
                    }, ' ▼')
                ]),
                showActionsDropdown && React.createElement('div', {
                    key: 'actions-dropdown-menu',
                    style: {
                        position: 'absolute',
                        top: '100%',
                        right: 0,
                        marginTop: '8px',
                        background: 'rgba(20, 20, 30, 0.98)',
                        backdropFilter: 'blur(20px)',
                        borderRadius: '12px',
                        border: '1px solid rgba(139, 92, 246, 0.3)',
                        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5), 0 0 20px rgba(139, 92, 246, 0.2)',
                        zIndex: 1000,
                        minWidth: '220px',
                        overflow: 'hidden',
                        animation: 'slideDown 0.3s ease-out'
                    }
                }, [
                    React.createElement('style', {
                        key: 'dropdown-animation'
                    }, `
                        @keyframes slideDown {
                            from {
                                opacity: 0;
                                transform: translateY(-10px) scale(0.95);
                            }
                            to {
                                opacity: 1;
                                transform: translateY(0) scale(1);
                            }
                        }
                    `),
                    React.createElement('div', {
                        key: 'dropdown-header',
                        style: {
                            padding: '12px 16px',
                            borderBottom: '1px solid rgba(139, 92, 246, 0.2)',
                            fontSize: '12px',
                            fontWeight: '600',
                            color: 'rgba(255, 255, 255, 0.5)',
                            textTransform: 'uppercase',
                            letterSpacing: '1px'
                        }
                    }, 'File Operations'),
                    React.createElement('button', {
                        key: 'new-folder-option',
                        onClick: () => {
                            setNewFolderName('');
                            setShowNewFolderModal(true);
                            setShowActionsDropdown(false);
                        },
                        style: {
                            width: '100%',
                            padding: '14px 16px',
                            background: 'transparent',
                            border: 'none',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px',
                            textAlign: 'left',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            transition: 'all 0.2s ease',
                            borderBottom: '1px solid rgba(255, 255, 255, 0.05)'
                        },
                        onMouseEnter: (e) => {
                            e.target.style.background = 'rgba(139, 92, 246, 0.2)';
                            e.target.style.paddingLeft = '20px';
                        },
                        onMouseLeave: (e) => {
                            e.target.style.background = 'transparent';
                            e.target.style.paddingLeft = '16px';
                        }
                    }, [
                        React.createElement('span', { key: 'folder-icon', style: { fontSize: '18px' } }, '📁'),
                        React.createElement('span', { key: 'folder-text' }, 'New Folder')
                    ]),
                    React.createElement('button', {
                        key: 'copy-option',
                        onClick: handleCopy,
                        disabled: selectedFiles.length === 0,
                        style: {
                            width: '100%',
                            padding: '14px 16px',
                            background: 'transparent',
                            border: 'none',
                            color: selectedFiles.length === 0 ? 'rgba(255, 255, 255, 0.3)' : 'white',
                            cursor: selectedFiles.length === 0 ? 'not-allowed' : 'pointer',
                            fontSize: '14px',
                            textAlign: 'left',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            transition: 'all 0.2s ease',
                            borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                            opacity: selectedFiles.length === 0 ? 0.5 : 1
                        },
                        onMouseEnter: (e) => {
                            if (selectedFiles.length > 0) {
                                e.target.style.background = 'rgba(59, 130, 246, 0.2)';
                                e.target.style.paddingLeft = '20px';
                            }
                        },
                        onMouseLeave: (e) => {
                            e.target.style.background = 'transparent';
                            e.target.style.paddingLeft = '16px';
                        }
                    }, [
                        React.createElement('span', { key: 'copy-icon', style: { fontSize: '18px' } }, '📋'),
                        React.createElement('div', { key: 'copy-content', style: { flex: 1 } }, [
                            React.createElement('div', { key: 'copy-text' }, 'Copy'),
                            selectedFiles.length > 0 && React.createElement('div', {
                                key: 'copy-count',
                                style: {
                                    fontSize: '11px',
                                    color: 'rgba(255, 255, 255, 0.5)',
                                    marginTop: '2px'
                                }
                            }, `${selectedFiles.length} item(s) selected`)
                        ])
                    ]),
                    React.createElement('button', {
                        key: 'cut-option',
                        onClick: handleCut,
                        disabled: selectedFiles.length === 0,
                        style: {
                            width: '100%',
                            padding: '14px 16px',
                            background: 'transparent',
                            border: 'none',
                            color: selectedFiles.length === 0 ? 'rgba(255, 255, 255, 0.3)' : 'white',
                            cursor: selectedFiles.length === 0 ? 'not-allowed' : 'pointer',
                            fontSize: '14px',
                            textAlign: 'left',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            transition: 'all 0.2s ease',
                            borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                            opacity: selectedFiles.length === 0 ? 0.5 : 1
                        },
                        onMouseEnter: (e) => {
                            if (selectedFiles.length > 0) {
                                e.target.style.background = 'rgba(251, 146, 60, 0.2)';
                                e.target.style.paddingLeft = '20px';
                            }
                        },
                        onMouseLeave: (e) => {
                            e.target.style.background = 'transparent';
                            e.target.style.paddingLeft = '16px';
                        }
                    }, [
                        React.createElement('span', { key: 'cut-icon', style: { fontSize: '18px' } }, '✂️'),
                        React.createElement('div', { key: 'cut-content', style: { flex: 1 } }, [
                            React.createElement('div', { key: 'cut-text' }, 'Move (Cut)'),
                            selectedFiles.length > 0 && React.createElement('div', {
                                key: 'cut-count',
                                style: {
                                    fontSize: '11px',
                                    color: 'rgba(255, 255, 255, 0.5)',
                                    marginTop: '2px'
                                }
                            }, `${selectedFiles.length} item(s) selected`)
                        ])
                    ]),
                    React.createElement('button', {
                        key: 'paste-option',
                        onClick: handlePaste,
                        disabled: clipboard.items.length === 0,
                        style: {
                            width: '100%',
                            padding: '14px 16px',
                            background: 'transparent',
                            border: 'none',
                            color: clipboard.items.length === 0 ? 'rgba(255, 255, 255, 0.3)' : 'white',
                            cursor: clipboard.items.length === 0 ? 'not-allowed' : 'pointer',
                            fontSize: '14px',
                            textAlign: 'left',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            transition: 'all 0.2s ease',
                            borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                            opacity: clipboard.items.length === 0 ? 0.5 : 1
                        },
                        onMouseEnter: (e) => {
                            if (clipboard.items.length > 0) {
                                e.target.style.background = 'rgba(34, 197, 94, 0.2)';
                                e.target.style.paddingLeft = '20px';
                            }
                        },
                        onMouseLeave: (e) => {
                            e.target.style.background = 'transparent';
                            e.target.style.paddingLeft = '16px';
                        }
                    }, [
                        React.createElement('span', { key: 'paste-icon', style: { fontSize: '18px' } }, '📌'),
                        React.createElement('div', { key: 'paste-content', style: { flex: 1 } }, [
                            React.createElement('div', { key: 'paste-text' }, 'Paste'),
                            React.createElement('div', {
                                key: 'paste-info',
                                style: {
                                    fontSize: '11px',
                                    color: 'rgba(255, 255, 255, 0.5)',
                                    marginTop: '2px'
                                }
                            }, clipboard.items.length > 0
                                ? `${clipboard.items.length} item(s) • ${clipboard.action === 'copy' ? 'Copy' : 'Move'}`
                                : 'Clipboard empty')
                        ])
                    ]),
                    React.createElement('button', {
                        key: 'rename-option',
                        onClick: handleRenameClick,
                        disabled: selectedFiles.length !== 1,
                        style: {
                            width: '100%',
                            padding: '14px 16px',
                            background: 'transparent',
                            border: 'none',
                            color: selectedFiles.length !== 1 ? 'rgba(255, 255, 255, 0.3)' : 'white',
                            cursor: selectedFiles.length !== 1 ? 'not-allowed' : 'pointer',
                            fontSize: '14px',
                            textAlign: 'left',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            transition: 'all 0.2s ease',
                            opacity: selectedFiles.length !== 1 ? 0.5 : 1
                        },
                        onMouseEnter: (e) => {
                            if (selectedFiles.length === 1) {
                                e.target.style.background = 'rgba(168, 85, 247, 0.2)';
                                e.target.style.paddingLeft = '20px';
                            }
                        },
                        onMouseLeave: (e) => {
                            e.target.style.background = 'transparent';
                            e.target.style.paddingLeft = '16px';
                        }
                    }, [
                        React.createElement('span', { key: 'rename-icon', style: { fontSize: '18px' } }, '✏️'),
                        React.createElement('div', { key: 'rename-content', style: { flex: 1 } }, [
                            React.createElement('div', { key: 'rename-text' }, 'Rename'),
                            selectedFiles.length === 1 && React.createElement('div', {
                                key: 'rename-file',
                                style: {
                                    fontSize: '11px',
                                    color: 'rgba(255, 255, 255, 0.5)',
                                    marginTop: '2px',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                }
                            }, selectedFiles[0].name)
                        ])
                    ])
                ])
            ]),
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
            }, [
                React.createElement('span', { key: 'delete-icon' }, '🗑️'),
                React.createElement('span', { key: 'delete-text' }, ` Delete (${selectedFiles.length})`)
            ]),

            selectedFiles.length > 0 && React.createElement('button', {
                onClick: handleDownload,
                key: 'download-selected',
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
            }, [
                React.createElement('span', { key: 'download-icon' }, '⬇️'),
                React.createElement('span', { key: 'download-text' }, ` Download (${selectedFiles.length})`)
            ]),

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
            onDragEnter: handleDragEnter,
            onDragOver: handleDragOver,
            onDragLeave: handleDragLeave,
            onDrop: handleDrop
        }, [
            // Show upload area overlay when dragging
            isDragging && React.createElement('div', {
                key: 'drag-overlay',
                style: {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(59, 130, 246, 0.2)',
                    border: '3px dashed #3b82f6',
                    borderRadius: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 999,
                    pointerEvents: 'none'
                }
            }, [
                React.createElement('div', {
                    key: 'drag-text',
                    style: {
                        textAlign: 'center',
                        padding: '40px'
                    }
                }, [
                    React.createElement('div', {
                        key: 'drag-icon',
                        style: {
                            fontSize: '64px',
                            marginBottom: '16px'
                        }
                    }, '📤'),
                    React.createElement('p', {
                        key: 'drag-message',
                        style: {
                            fontSize: '24px',
                            fontWeight: 'bold',
                            color: '#3b82f6',
                            margin: 0
                        }
                    }, 'Drop files here to upload')
                ])
            ]),

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
                background: 'rgba(0, 0, 0, 0.7)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000
            },
            onClick: (e) => {
                if (e.target === e.currentTarget) {
                    setShowUploadModal(false);
                    setUploadingFiles([]);
                }
            }
        }, [
            React.createElement('div', {
                key: 'upload-modal-content',
                style: {
                    background: 'rgba(30, 40, 50, 0.95)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '16px',
                    padding: '32px',
                    width: '560px',
                    maxWidth: '90%',
                    maxHeight: '90vh',
                    overflowY: 'auto',
                    boxShadow: '0 25px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
                    border: '1px solid rgba(255, 255, 255, 0.1)'
                }
            }, [
                React.createElement('h2', {
                    key: 'upload-title',
                    style: {
                        color: 'white',
                        margin: '0 0 8px 0',
                        fontSize: '24px',
                        fontWeight: '600',
                        textAlign: 'center'
                    }
                }, '📤 Upload Files'),

                React.createElement('p', {
                    key: 'upload-path',
                    style: {
                        color: 'rgba(255, 255, 255, 0.6)',
                        margin: '0 0 16px 0',
                        fontSize: '14px',
                        textAlign: 'center'
                    }
                }, `Uploading to: ${currentPath || '/'}`),

                // Upload mode selector
                React.createElement('div', {
                    key: 'upload-mode-selector',
                    style: {
                        display: 'flex',
                        gap: '8px',
                        marginBottom: '24px',
                        justifyContent: 'center'
                    }
                }, [
                    React.createElement('button', {
                        key: 'files-mode',
                        onClick: () => setUploadMode('files'),
                        style: {
                            flex: 1,
                            padding: '10px 16px',
                            background: uploadMode === 'files'
                                ? 'linear-gradient(135deg, #3b82f6, #2563eb)'
                                : 'rgba(255, 255, 255, 0.1)',
                            border: uploadMode === 'files'
                                ? '2px solid #3b82f6'
                                : '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px',
                            fontWeight: uploadMode === 'files' ? '600' : '400',
                            transition: 'all 0.2s ease'
                        }
                    }, '📄 Upload Files'),
                    React.createElement('button', {
                        key: 'folder-mode',
                        onClick: () => setUploadMode('folder'),
                        style: {
                            flex: 1,
                            padding: '10px 16px',
                            background: uploadMode === 'folder'
                                ? 'linear-gradient(135deg, #10b981, #059669)'
                                : 'rgba(255, 255, 255, 0.1)',
                            border: uploadMode === 'folder'
                                ? '2px solid #10b981'
                                : '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px',
                            fontWeight: uploadMode === 'folder' ? '600' : '400',
                            transition: 'all 0.2s ease'
                        }
                    }, '📁 Upload Folder')
                ]),

                React.createElement('div', {
                    key: 'upload-drop-zone',
                    style: {
                        marginBottom: '24px'
                    },
                    onDragEnter: (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    },
                    onDragOver: (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.style.borderColor = '#3b82f6';
                        e.currentTarget.style.background = 'rgba(59, 130, 246, 0.1)';
                    },
                    onDragLeave: (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.4)';
                        e.currentTarget.style.background = 'rgba(59, 130, 246, 0.05)';
                    },
                    onDrop: (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.4)';
                        e.currentTarget.style.background = 'rgba(59, 130, 246, 0.05)';
                        const files = Array.from(e.dataTransfer.files);
                        if (files.length > 0) {
                            setUploadingFiles(files);
                        }
                    }
                }, [
                    React.createElement('div', {
                        key: 'drop-zone-inner',
                        style: {
                            padding: '40px 20px',
                            border: '2px dashed rgba(59, 130, 246, 0.4)',
                            borderRadius: '12px',
                            background: 'rgba(59, 130, 246, 0.05)',
                            textAlign: 'center',
                            transition: 'all 0.3s ease',
                            cursor: 'pointer'
                        },
                        onClick: () => {
                            document.getElementById('file-input-upload').click();
                        }
                    }, [
                        React.createElement('div', {
                            key: 'upload-icon',
                            style: {
                                fontSize: '48px',
                                marginBottom: '16px'
                            }
                        }, '📁'),
                        React.createElement('p', {
                            key: 'upload-text-1',
                            style: {
                                color: 'rgba(255, 255, 255, 0.9)',
                                fontSize: '16px',
                                fontWeight: '500',
                                margin: '0 0 8px 0'
                            }
                        }, uploadMode === 'folder' ? 'Click below to select a folder' : 'Drag and drop files here'),
                        React.createElement('p', {
                            key: 'upload-text-2',
                            style: {
                                color: 'rgba(255, 255, 255, 0.5)',
                                fontSize: '14px',
                                margin: '0 0 16px 0'
                            }
                        }, 'or'),
                        React.createElement('button', {
                            key: 'browse-button',
                            type: 'button',
                            onClick: (e) => {
                                e.stopPropagation();
                                document.getElementById('file-input-upload').click();
                            },
                            style: {
                                padding: '10px 24px',
                                background: 'rgba(59, 130, 246, 0.2)',
                                border: '1px solid rgba(59, 130, 246, 0.5)',
                                borderRadius: '8px',
                                color: '#60a5fa',
                                cursor: 'pointer',
                                fontSize: '14px',
                                fontWeight: '500',
                                transition: 'all 0.2s ease'
                            },
                            onMouseEnter: (e) => {
                                e.target.style.background = 'rgba(59, 130, 246, 0.3)';
                                e.target.style.borderColor = '#3b82f6';
                            },
                            onMouseLeave: (e) => {
                                e.target.style.background = 'rgba(59, 130, 246, 0.2)';
                                e.target.style.borderColor = 'rgba(59, 130, 246, 0.5)';
                            }
                        }, uploadMode === 'folder' ? 'Select Folder' : 'Browse Files')
                    ]),

                    React.createElement('input', {
                        key: 'file-input-upload',
                        id: 'file-input-upload',
                        type: 'file',
                        multiple: uploadMode === 'files',
                        webkitdirectory: uploadMode === 'folder' ? '' : undefined,
                        directory: uploadMode === 'folder' ? '' : undefined,
                        onChange: (e) => {
                            const files = Array.from(e.target.files);
                            console.log('Selected files:', files.length);
                            if (uploadMode === 'folder' && files.length > 0) {
                                console.log('Folder upload - first file path:', files[0].webkitRelativePath);
                            }
                            setUploadingFiles(files);
                        },
                        style: {
                            display: 'none'
                        }
                    })
                ]),
                
                uploadingFiles.length > 0 && React.createElement('div', {
                    key: 'uploading-files-section',
                    style: {
                        marginBottom: '24px'
                    }
                }, [
                    // Progress bar
                    isUploading && React.createElement('div', {
                        key: 'upload-progress-section',
                        style: {
                            marginBottom: '16px'
                        }
                    }, [
                        React.createElement('div', {
                            key: 'progress-label',
                            style: {
                                color: 'rgba(255, 255, 255, 0.9)',
                                fontSize: '14px',
                                marginBottom: '8px',
                                display: 'flex',
                                justifyContent: 'space-between'
                            }
                        }, [
                            React.createElement('span', { key: 'uploading-text' }, uploadDetails
                                ? `Uploading... (${uploadDetails.successCount + uploadDetails.failedCount}/${uploadDetails.totalFiles} files)`
                                : 'Uploading...'),
                            React.createElement('span', { key: 'progress-percent' }, `${uploadProgress}%`)
                        ]),
                        React.createElement('div', {
                            key: 'progress-bar-bg',
                            style: {
                                width: '100%',
                                height: '8px',
                                background: 'rgba(255, 255, 255, 0.1)',
                                borderRadius: '4px',
                                overflow: 'hidden'
                            }
                        }, [
                            React.createElement('div', {
                                key: 'progress-bar-fill',
                                style: {
                                    width: `${uploadProgress}%`,
                                    height: '100%',
                                    background: 'linear-gradient(90deg, #10b981, #059669)',
                                    transition: 'width 0.3s ease',
                                    borderRadius: '4px'
                                }
                            })
                        ])
                    ]),

                    // Batch upload details
                    isUploading && uploadDetails && React.createElement('div', {
                        key: 'batch-details-section',
                        style: {
                            marginBottom: '16px',
                            padding: '12px',
                            background: 'rgba(59, 130, 246, 0.1)',
                            borderRadius: '8px',
                            border: '1px solid rgba(59, 130, 246, 0.2)'
                        }
                    }, [
                        React.createElement('div', {
                            key: 'batch-stats',
                            style: {
                                display: 'flex',
                                justifyContent: 'space-around',
                                fontSize: '12px',
                                color: 'rgba(255, 255, 255, 0.8)'
                            }
                        }, [
                            React.createElement('div', { key: 'success-stat' }, [
                                React.createElement('span', { key: 'success-icon', style: { color: '#10b981' } }, '✓ '),
                                React.createElement('span', { key: 'success-count' }, `${uploadDetails.successCount} Success`)
                            ]),
                            React.createElement('div', { key: 'failed-stat' }, [
                                React.createElement('span', { key: 'failed-icon', style: { color: '#ef4444' } }, '✗ '),
                                React.createElement('span', { key: 'failed-count' }, `${uploadDetails.failedCount} Failed`)
                            ]),
                            React.createElement('div', { key: 'pending-stat' }, [
                                React.createElement('span', { key: 'pending-icon', style: { color: '#f59e0b' } }, '⏳ '),
                                React.createElement('span', { key: 'pending-count' }, `${uploadDetails.totalFiles - uploadDetails.successCount - uploadDetails.failedCount} Pending`)
                            ])
                        ])
                    ]),

                    // File list
                    React.createElement('div', {
                        key: 'uploading-files-list',
                        style: {
                            maxHeight: '300px',
                            overflowY: 'auto',
                            padding: '16px',
                            background: 'rgba(0, 0, 0, 0.2)',
                            borderRadius: '12px',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            // Important: ensure the scroll container doesn't interfere with modal scroll
                            position: 'relative',
                            WebkitOverflowScrolling: 'touch' // smooth scrolling on iOS
                        }
                    }, [
                    React.createElement('h3', {
                        key: 'files-list-header',
                        style: {
                            color: 'white',
                            margin: '0 0 12px 0',
                            fontSize: '16px',
                            fontWeight: '600',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                        }
                    }, [
                        React.createElement('span', { key: 'check-icon' }, '✓'),
                        React.createElement('span', { key: 'files-count' }, `${uploadingFiles.length} file(s) selected`)
                    ]),

                    React.createElement('ul', {
                        key: 'files-list-ul',
                        style: {
                            listStyle: 'none',
                            padding: 0,
                            margin: 0
                        }
                    }, uploadingFiles.map((file, index) =>
                        React.createElement('li', {
                            key: file.name + '-' + index,
                            style: {
                                padding: '10px 12px',
                                background: 'rgba(59, 130, 246, 0.1)',
                                border: '1px solid rgba(59, 130, 246, 0.2)',
                                borderRadius: '8px',
                                marginBottom: '6px',
                                fontSize: '14px',
                                color: 'rgba(255, 255, 255, 0.95)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                                transition: 'all 0.2s ease'
                            }
                        }, [
                            React.createElement('span', {
                                key: 'file-icon-' + index,
                                style: { fontSize: '18px' }
                            }, '📄'),
                            React.createElement('span', {
                                key: 'file-name-' + index,
                                style: {
                                    flex: 1,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                }
                            }, file.name),
                            React.createElement('span', {
                                key: 'file-size-' + index,
                                style: {
                                    fontSize: '12px',
                                    color: 'rgba(255, 255, 255, 0.5)'
                                }
                            }, `${(file.size / 1024).toFixed(1)} KB`)
                        ])
                    ))
                    ])
                ]),

                React.createElement('div', {
                    key: 'upload-buttons',
                    style: {
                        display: 'flex',
                        gap: '12px'
                    }
                }, [
                    React.createElement('button', {
                        key: 'cancel-upload',
                        onClick: () => {
                            setShowUploadModal(false);
                            setUploadingFiles([]);
                        },
                        style: {
                            flex: 1,
                            padding: '14px',
                            background: 'rgba(255, 255, 255, 0.08)',
                            backdropFilter: 'blur(10px)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '10px',
                            color: 'rgba(255, 255, 255, 0.9)',
                            cursor: 'pointer',
                            fontSize: '15px',
                            fontWeight: '500',
                            transition: 'all 0.2s ease'
                        },
                        onMouseEnter: (e) => {
                            e.target.style.background = 'rgba(255, 255, 255, 0.15)';
                            e.target.style.borderColor = 'rgba(255, 255, 255, 0.3)';
                        },
                        onMouseLeave: (e) => {
                            e.target.style.background = 'rgba(255, 255, 255, 0.08)';
                            e.target.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                        }
                    }, 'Cancel'),

                    React.createElement('button', {
                        key: 'confirm-upload',
                        onClick: () => handleFileUpload(uploadingFiles),
                        disabled: uploadingFiles.length === 0,
                        style: {
                            flex: 1,
                            padding: '14px',
                            background: uploadingFiles.length === 0
                                ? 'rgba(100, 100, 100, 0.3)'
                                : 'linear-gradient(135deg, #10b981, #059669)',
                            border: 'none',
                            borderRadius: '10px',
                            color: 'white',
                            cursor: uploadingFiles.length === 0 ? 'not-allowed' : 'pointer',
                            fontSize: '15px',
                            fontWeight: '600',
                            boxShadow: uploadingFiles.length === 0
                                ? 'none'
                                : '0 4px 12px rgba(16, 185, 129, 0.3)',
                            transition: 'all 0.2s ease',
                            opacity: uploadingFiles.length === 0 ? 0.5 : 1
                        },
                        onMouseEnter: (e) => {
                            if (uploadingFiles.length > 0) {
                                e.target.style.transform = 'translateY(-2px)';
                                e.target.style.boxShadow = '0 6px 20px rgba(16, 185, 129, 0.4)';
                            }
                        },
                        onMouseLeave: (e) => {
                            if (uploadingFiles.length > 0) {
                                e.target.style.transform = 'translateY(0)';
                                e.target.style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.3)';
                            }
                        }
                    }, uploadingFiles.length === 0
                        ? 'Upload'
                        : `Upload ${uploadingFiles.length} file${uploadingFiles.length > 1 ? 's' : ''}`)
                ])
            ])
        ]),

        // New Folder Modal
        showNewFolderModal && React.createElement('div', {
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
                key: 'new-folder-modal-content',
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
                    key: 'folder-title',
                    style: {
                        color: 'white',
                        margin: '0 0 24px 0',
                        fontSize: '22px',
                        textAlign: 'center'
                    }
                }, 'Create New Folder'),

                React.createElement('input', {
                    key: 'folder-name-input',
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
                    key: 'folder-buttons',
                    style: {
                        display: 'flex',
                        gap: '12px'
                    }
                }, [
                    React.createElement('button', {
                        key: 'cancel-folder',
                        onClick: () => {
                            setShowNewFolderModal(false);
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
                        key: 'create-folder',
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

        // Rename Modal
        showRenameModal && React.createElement('div', {
            key: 'rename-modal',
            style: {
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0, 0, 0, 0.7)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000
            },
            onClick: (e) => {
                if (e.target === e.currentTarget) {
                    setShowRenameModal(false);
                    setRenameTarget(null);
                    setNewName('');
                }
            }
        }, [
            React.createElement('div', {
                style: {
                    background: 'rgba(30, 40, 50, 0.95)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '16px',
                    padding: '32px',
                    width: '450px',
                    maxWidth: '90%',
                    boxShadow: '0 25px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
                    border: '1px solid rgba(255, 255, 255, 0.1)'
                }
            }, [
                React.createElement('h2', {
                    style: {
                        color: 'white',
                        margin: '0 0 8px 0',
                        fontSize: '24px',
                        fontWeight: '600',
                        textAlign: 'center',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '10px'
                    }
                }, [
                    React.createElement('span', { key: 'rename-icon' }, '✏️'),
                    React.createElement('span', { key: 'rename-title' }, 'Rename File')
                ]),

                React.createElement('p', {
                    style: {
                        color: 'rgba(255, 255, 255, 0.6)',
                        margin: '0 0 24px 0',
                        fontSize: '14px',
                        textAlign: 'center'
                    }
                }, renameTarget ? `Renaming: ${renameTarget.name}` : ''),

                React.createElement('input', {
                    type: 'text',
                    placeholder: 'Enter new name',
                    value: newName,
                    onChange: (e) => setNewName(e.target.value),
                    onKeyPress: (e) => {
                        if (e.key === 'Enter') {
                            executeRename();
                        }
                    },
                    autoFocus: true,
                    style: {
                        width: '100%',
                        padding: '14px 16px',
                        border: '1px solid rgba(139, 92, 246, 0.3)',
                        borderRadius: '10px',
                        background: 'rgba(139, 92, 246, 0.05)',
                        color: 'white',
                        fontSize: '15px',
                        marginBottom: '24px',
                        outline: 'none',
                        transition: 'all 0.2s ease'
                    }
                }),

                error && React.createElement('div', {
                    key: 'rename-error',
                    style: {
                        color: '#ef4444',
                        textAlign: 'center',
                        padding: '12px',
                        background: 'rgba(239, 68, 68, 0.1)',
                        borderRadius: '8px',
                        marginBottom: '16px',
                        fontSize: '14px'
                    }
                }, error),

                React.createElement('div', {
                    style: {
                        display: 'flex',
                        gap: '12px'
                    }
                }, [
                    React.createElement('button', {
                        key: 'cancel-rename',
                        onClick: () => {
                            setShowRenameModal(false);
                            setRenameTarget(null);
                            setNewName('');
                            setError('');
                        },
                        style: {
                            flex: 1,
                            padding: '14px',
                            background: 'rgba(255, 255, 255, 0.08)',
                            backdropFilter: 'blur(10px)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '10px',
                            color: 'rgba(255, 255, 255, 0.9)',
                            cursor: 'pointer',
                            fontSize: '15px',
                            fontWeight: '500',
                            transition: 'all 0.2s ease'
                        },
                        onMouseEnter: (e) => {
                            e.target.style.background = 'rgba(255, 255, 255, 0.15)';
                            e.target.style.borderColor = 'rgba(255, 255, 255, 0.3)';
                        },
                        onMouseLeave: (e) => {
                            e.target.style.background = 'rgba(255, 255, 255, 0.08)';
                            e.target.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                        }
                    }, 'Cancel'),

                    React.createElement('button', {
                        key: 'confirm-rename',
                        onClick: executeRename,
                        disabled: !newName.trim(),
                        style: {
                            flex: 1,
                            padding: '14px',
                            background: !newName.trim()
                                ? 'rgba(100, 100, 100, 0.3)'
                                : 'linear-gradient(135deg, #8b5cf6, #7c3aed)',
                            border: 'none',
                            borderRadius: '10px',
                            color: 'white',
                            cursor: !newName.trim() ? 'not-allowed' : 'pointer',
                            fontSize: '15px',
                            fontWeight: '600',
                            boxShadow: !newName.trim()
                                ? 'none'
                                : '0 4px 12px rgba(139, 92, 246, 0.3)',
                            transition: 'all 0.2s ease',
                            opacity: !newName.trim() ? 0.5 : 1
                        },
                        onMouseEnter: (e) => {
                            if (newName.trim()) {
                                e.target.style.transform = 'translateY(-2px)';
                                e.target.style.boxShadow = '0 6px 20px rgba(139, 92, 246, 0.4)';
                            }
                        },
                        onMouseLeave: (e) => {
                            if (newName.trim()) {
                                e.target.style.transform = 'translateY(0)';
                                e.target.style.boxShadow = '0 4px 12px rgba(139, 92, 246, 0.3)';
                            }
                        }
                    }, 'Rename')
                ])
            ])
        ]),

        // Change Password Modal
        showChangePasswordModal && React.createElement('div', {
            key: 'change-password-modal',
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
                }, 'Change Password'),
                
                React.createElement('form', {
                    onSubmit: (e) => {
                        e.preventDefault();
                        const formData = new FormData(e.target);
                        const oldPassword = formData.get('oldPassword');
                        const newPassword = formData.get('newPassword');
                        const confirmPassword = formData.get('confirmPassword');
                        
                        if (newPassword !== confirmPassword) {
                            setError('Passwords do not match');
                            return;
                        }
                        
                        handleChangePassword(oldPassword, newPassword);
                    },
                    style: { display: 'flex', flexDirection: 'column', gap: '16px' }
                }, [
                    React.createElement('input', {
                        key: 'old-password',
                        name: 'oldPassword',
                        type: 'password',
                        placeholder: 'Current password',
                        required: true,
                        style: {
                            width: '100%',
                            padding: '14px',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'white',
                            fontSize: '16px'
                        }
                    }),
                    
                    React.createElement('input', {
                        key: 'new-password',
                        name: 'newPassword',
                        type: 'password',
                        placeholder: 'New password',
                        required: true,
                        style: {
                            width: '100%',
                            padding: '14px',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'white',
                            fontSize: '16px'
                        }
                    }),
                    
                    React.createElement('input', {
                        key: 'confirm-password',
                        name: 'confirmPassword',
                        type: 'password',
                        placeholder: 'Confirm new password',
                        required: true,
                        style: {
                            width: '100%',
                            padding: '14px',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'white',
                            fontSize: '16px'
                        }
                    }),
                    
                    error && React.createElement('div', {
                        key: 'password-error',
                        style: { 
                            color: '#ef4444', 
                            textAlign: 'center',
                            padding: '12px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            borderRadius: '8px'
                        }
                    }, error),
                    
                    React.createElement('div', {
                        key: 'password-buttons',
                        style: {
                            display: 'flex',
                            gap: '12px'
                        }
                    }, [
                        React.createElement('button', {
                            key: 'cancel-password',
                            type: 'button',
                            onClick: () => {
                                setShowChangePasswordModal(false);
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
                            key: 'save-password',
                            type: 'submit',
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
                        }, 'Change Password')
                    ])
                ])
            ])
        ]),


    ]);
};

// Make FileBrowser component available globally  
if (!window.FileTransferApp) {
    window.FileTransferApp = {};
}
window.FileTransferApp.FileBrowser = FileBrowser;

// Export for use in main app
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FileBrowser };
}