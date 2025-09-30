// File Browser Component with glass effect
const FileBrowser = ({ token, user }) => {
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [showUserDropdown, setShowUserDropdown] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [filteredFiles, setFilteredFiles] = useState([]);
    const [currentPath, setCurrentPath] = useState('.');

    useEffect(() => {
        fetchFiles(currentPath);
    }, [currentPath]);

    useEffect(() => {
        if (searchQuery.trim() === '') {
            setFilteredFiles(files);
        } else {
            const filtered = files.filter(file => 
                file.name.toLowerCase().includes(searchQuery.toLowerCase())
            );
            setFilteredFiles(filtered);
        }
    }, [files, searchQuery]);

    const fetchFiles = async (path) => {
        setLoading(true);
        setError('');
        try {
            const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (response.ok) {
                const data = await response.json();
                setFiles(data);
            } else {
                setError('Failed to load files');
            }
        } catch (error) {
            console.error('Error fetching files:', error);
            setError('Connection error');
        } finally {
            setLoading(false);
        }
    };

    const handleFileClick = (file) => {
        if (file.isDirectory) {
            setCurrentPath(file.path);
        }
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        window.location.reload();
    };

    const getFileIcon = (item) => {
        if (item.isDirectory) {
            return '📂';
        }
        const ext = item.name.split('.').pop().toLowerCase();
        switch (ext) {
            case 'txt': case 'log': case 'md': return '📄';
            case 'jpg': case 'jpeg': case 'png': case 'gif': return '🖼️';
            case 'mp4': case 'avi': case 'mov': return '🎬';
            case 'mp3': case 'wav': return '🎵';
            case 'zip': case 'rar': return '📦';
            case 'pdf': return '📕';
            default: return '📄';
        }
    };

    if (loading) {
        return (
            <div style={{
                minHeight: '100vh',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
            }}>
                <div style={{
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '20px',
                    padding: '40px',
                    textAlign: 'center',
                    border: '1px solid rgba(255, 255, 255, 0.2)'
                }}>
                    <div style={{
                        width: '60px',
                        height: '60px',
                        border: '4px solid rgba(255, 255, 255, 0.3)',
                        borderTop: '4px solid white',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite',
                        margin: '0 auto 20px'
                    }}></div>
                    <p style={{ color: 'white', margin: 0, fontSize: '18px' }}>Loading files...</p>
                </div>
            </div>
        );
    }

    return (
        <div style={{
            minHeight: '100vh',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            position: 'relative',
            overflow: 'hidden'
        }}>
            {/* Background elements */}
            <div style={{
                position: 'absolute',
                top: '-100px',
                right: '-100px',
                width: '200px',
                height: '200px',
                background: 'rgba(147, 51, 234, 0.2)',
                borderRadius: '50%',
                filter: 'blur(30px)',
                animation: 'pulse 6s ease-in-out infinite'
            }}></div>
            <div style={{
                position: 'absolute',
                bottom: '-100px',
                left: '-100px',
                width: '200px',
                height: '200px',
                background: 'rgba(59, 130, 246, 0.2)',
                borderRadius: '50%',
                filter: 'blur(30px)',
                animation: 'pulse 6s ease-in-out infinite 3s'
            }}></div>

            {/* Header */}
            <div style={{
                background: 'rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(20px)',
                borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
                padding: '16px 24px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                position: 'relative',
                zIndex: 10
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <div style={{
                        width: '48px',
                        height: '48px',
                        background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                        borderRadius: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        boxShadow: '0 4px 15px rgba(0, 0, 0, 0.2)'
                    }}>
                        <span style={{ fontSize: '20px' }}>📁</span>
                    </div>
                    <div>
                        <h1 style={{
                            color: 'white',
                            margin: 0,
                            fontSize: '24px',
                            fontWeight: 'bold'
                        }}>
                            File Transfer UI
                        </h1>
                        <p style={{
                            color: 'rgba(255, 255, 255, 0.8)',
                            margin: 0,
                            fontSize: '14px'
                        }}>
                            Futuristic File Management
                        </p>
                    </div>
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    {/* User Dropdown */}
                    <div style={{ position: 'relative' }}>
                        <button
                            onClick={() => setShowUserDropdown(!showUserDropdown)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '12px',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '12px',
                                padding: '12px 16px',
                                color: 'white',
                                cursor: 'pointer',
                                backdropFilter: 'blur(10px)',
                                transition: 'all 0.3s ease',
                                outline: 'none'
                            }}
                            onMouseEnter={(e) => {
                                e.target.style.background = 'rgba(255, 255, 255, 0.2)';
                            }}
                            onMouseLeave={(e) => {
                                e.target.style.background = 'rgba(255, 255, 255, 0.1)';
                            }}
                        >
                            <div style={{
                                width: '32px',
                                height: '32px',
                                background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                                borderRadius: '50%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'white',
                                fontWeight: 'bold',
                                fontSize: '14px'
                            }}>
                                {user?.username?.charAt(0).toUpperCase()}
                            </div>
                            <div style={{ textAlign: 'left' }}>
                                <p style={{ margin: 0, fontSize: '14px', fontWeight: '600' }}>
                                    {user?.username}
                                </p>
                                <p style={{ margin: 0, fontSize: '12px', opacity: 0.8 }}>
                                    Administrator
                                </p>
                            </div>
                            <svg style={{
                                width: '16px',
                                height: '16px',
                                transition: 'transform 0.3s ease',
                                transform: showUserDropdown ? 'rotate(180deg)' : 'rotate(0deg)'
                            }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                        </button>

                        {/* Dropdown Menu */}
                        {showUserDropdown && (
                            <UserDropdown 
                                user={user}
                                onSettings={() => {
                                    setShowSettingsModal(true);
                                    setShowUserDropdown(false);
                                }}
                                onLogout={() => {
                                    handleLogout();
                                    setShowUserDropdown(false);
                                }}
                                onClose={() => setShowUserDropdown(false)}
                            />
                        )}
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div style={{ padding: '24px', position: 'relative', zIndex: 10 }}>
                <div style={{
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '20px',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                    overflow: 'hidden'
                }}>
                    {/* Toolbar */}
                    <div style={{
                        padding: '20px 24px',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                    }}>
                        <h2 style={{
                            color: 'white',
                            margin: 0,
                            fontSize: '20px',
                            fontWeight: '600'
                        }}>
                            Files ({filteredFiles.length})
                        </h2>
                        
                        {/* Search */}
                        <div style={{ position: 'relative' }}>
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search files..."
                                style={{
                                    width: '300px',
                                    padding: '12px 16px 12px 40px',
                                    background: 'rgba(255, 255, 255, 0.1)',
                                    border: '1px solid rgba(255, 255, 255, 0.2)',
                                    borderRadius: '12px',
                                    color: 'white',
                                    fontSize: '14px',
                                    backdropFilter: 'blur(10px)',
                                    outline: 'none',
                                    transition: 'all 0.3s ease'
                                }}
                                onFocus={(e) => {
                                    e.target.style.borderColor = 'rgba(59, 130, 246, 0.8)';
                                    e.target.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.1)';
                                }}
                                onBlur={(e) => {
                                    e.target.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                                    e.target.style.boxShadow = 'none';
                                }}
                            />
                            <div style={{
                                position: 'absolute',
                                left: '12px',
                                top: '50%',
                                transform: 'translateY(-50%)',
                                color: 'rgba(255, 255, 255, 0.6)',
                                fontSize: '16px'
                            }}>
                                🔍
                            </div>
                            {searchQuery && (
                                <button
                                    onClick={() => setSearchQuery('')}
                                    style={{
                                        position: 'absolute',
                                        right: '12px',
                                        top: '50%',
                                        transform: 'translateY(-50%)',
                                        background: 'none',
                                        border: 'none',
                                        color: 'rgba(255, 255, 255, 0.6)',
                                        cursor: 'pointer',
                                        fontSize: '16px',
                                        outline: 'none'
                                    }}
                                >
                                    ✕
                                </button>
                            )}
                        </div>
                    </div>

                    {/* File List */}
                    <FileList 
                        files={filteredFiles}
                        searchQuery={searchQuery}
                        onClearSearch={() => setSearchQuery('')}
                        getFileIcon={getFileIcon}
                        error={error}
                        onFileClick={handleFileClick}
                    />
                </div>
            </div>

            {/* Settings Modal */}
            {showSettingsModal && (
                <SettingsModal 
                    onClose={() => setShowSettingsModal(false)}
                    token={token}
                />
            )}
        </div>
    );
};
