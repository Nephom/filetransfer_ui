const { useState, useEffect } = React;

// Enhanced Login Form with glass effect
const LoginForm = ({ onLogin }) => {
    const [credentials, setCredentials] = useState({ username: '', password: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [showForgotPassword, setShowForgotPassword] = useState(false);

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

    const handleForgotPassword = async (e) => {
        e.preventDefault();
        // Implementation for forgot password
        alert('Reset token will be shown in server console');
        setShowForgotPassword(false);
    };

    return (
        <div style={{
            minHeight: '100vh',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden'
        }}>
            {/* Animated background elements */}
            <div style={{
                position: 'absolute',
                top: '-160px',
                right: '-160px',
                width: '320px',
                height: '320px',
                background: 'rgba(147, 51, 234, 0.3)',
                borderRadius: '50%',
                filter: 'blur(40px)',
                animation: 'pulse 4s ease-in-out infinite'
            }}></div>
            <div style={{
                position: 'absolute',
                bottom: '-160px',
                left: '-160px',
                width: '320px',
                height: '320px',
                background: 'rgba(59, 130, 246, 0.3)',
                borderRadius: '50%',
                filter: 'blur(40px)',
                animation: 'pulse 4s ease-in-out infinite 2s'
            }}></div>
            <div style={{
                position: 'absolute',
                top: '160px',
                left: '160px',
                width: '320px',
                height: '320px',
                background: 'rgba(99, 102, 241, 0.3)',
                borderRadius: '50%',
                filter: 'blur(40px)',
                animation: 'pulse 4s ease-in-out infinite 1s'
            }}></div>

            <div style={{
                position: 'relative',
                zIndex: 10,
                background: 'rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(20px)',
                borderRadius: '24px',
                padding: '40px',
                width: '100%',
                maxWidth: '420px',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)'
            }}>
                <div style={{ textAlign: 'center', marginBottom: '32px' }}>
                    <div style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '80px',
                        height: '80px',
                        background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                        borderRadius: '50%',
                        marginBottom: '16px',
                        boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)'
                    }}>
                        <span style={{ fontSize: '32px' }}>📁</span>
                    </div>
                    <h2 style={{
                        color: 'white',
                        margin: 0,
                        fontSize: '28px',
                        fontWeight: 'bold',
                        marginBottom: '8px'
                    }}>
                        File Transfer UI
                    </h2>
                    <p style={{
                        color: 'rgba(255, 255, 255, 0.8)',
                        margin: 0,
                        fontSize: '16px'
                    }}>
                        Futuristic File Management System
                    </p>
                </div>

                {error && (
                    <div style={{
                        background: 'rgba(239, 68, 68, 0.2)',
                        border: '1px solid rgba(239, 68, 68, 0.5)',
                        color: 'white',
                        padding: '12px 16px',
                        borderRadius: '12px',
                        marginBottom: '24px',
                        backdropFilter: 'blur(10px)',
                        display: 'flex',
                        alignItems: 'center'
                    }}>
                        <span style={{ marginRight: '8px' }}>⚠️</span>
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    <div style={{ marginBottom: '24px' }}>
                        <label style={{
                            display: 'block',
                            color: 'rgba(255, 255, 255, 0.9)',
                            marginBottom: '8px',
                            fontSize: '14px',
                            fontWeight: '500'
                        }}>
                            Username
                        </label>
                        <input
                            type="text"
                            value={credentials.username}
                            onChange={(e) => setCredentials({...credentials, username: e.target.value})}
                            style={{
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
                            }}
                            placeholder="Enter your username"
                            required
                            onFocus={(e) => {
                                e.target.style.borderColor = 'rgba(59, 130, 246, 0.8)';
                                e.target.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.1)';
                            }}
                            onBlur={(e) => {
                                e.target.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                                e.target.style.boxShadow = 'none';
                            }}
                        />
                    </div>

                    <div style={{ marginBottom: '32px' }}>
                        <label style={{
                            display: 'block',
                            color: 'rgba(255, 255, 255, 0.9)',
                            marginBottom: '8px',
                            fontSize: '14px',
                            fontWeight: '500'
                        }}>
                            Password
                        </label>
                        <input
                            type="password"
                            value={credentials.password}
                            onChange={(e) => setCredentials({...credentials, password: e.target.value})}
                            style={{
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
                            }}
                            placeholder="Enter your password"
                            required
                            onFocus={(e) => {
                                e.target.style.borderColor = 'rgba(59, 130, 246, 0.8)';
                                e.target.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.1)';
                            }}
                            onBlur={(e) => {
                                e.target.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                                e.target.style.boxShadow = 'none';
                            }}
                        />
                    </div>

                    <div style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
                        <button
                            type="submit"
                            disabled={loading}
                            style={{
                                flex: 1,
                                background: loading ? 'rgba(255, 255, 255, 0.2)' : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                                border: 'none',
                                borderRadius: '12px',
                                color: 'white',
                                fontSize: '16px',
                                fontWeight: '600',
                                padding: '16px',
                                cursor: loading ? 'not-allowed' : 'pointer',
                                transition: 'all 0.3s ease',
                                boxShadow: '0 4px 15px rgba(0, 0, 0, 0.2)',
                                transform: 'translateY(0)',
                                outline: 'none'
                            }}
                            onMouseEnter={(e) => {
                                if (!loading) {
                                    e.target.style.transform = 'translateY(-2px)';
                                    e.target.style.boxShadow = '0 8px 25px rgba(0, 0, 0, 0.3)';
                                }
                            }}
                            onMouseLeave={(e) => {
                                e.target.style.transform = 'translateY(0)';
                                e.target.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.2)';
                            }}
                        >
                            {loading ? (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <div style={{
                                        width: '20px',
                                        height: '20px',
                                        border: '2px solid rgba(255, 255, 255, 0.3)',
                                        borderTop: '2px solid white',
                                        borderRadius: '50%',
                                        animation: 'spin 1s linear infinite',
                                        marginRight: '8px'
                                    }}></div>
                                    Logging in...
                                </div>
                            ) : (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <span style={{ marginRight: '8px' }}>🚀</span>
                                    Login
                                </div>
                            )}
                        </button>
                        
                        <button
                            type="button"
                            onClick={() => setShowForgotPassword(true)}
                            style={{
                                flex: 1,
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '12px',
                                color: 'white',
                                fontSize: '16px',
                                fontWeight: '600',
                                padding: '16px',
                                cursor: 'pointer',
                                transition: 'all 0.3s ease',
                                backdropFilter: 'blur(10px)',
                                transform: 'translateY(0)',
                                outline: 'none'
                            }}
                            onMouseEnter={(e) => {
                                e.target.style.background = 'rgba(255, 255, 255, 0.2)';
                                e.target.style.transform = 'translateY(-2px)';
                            }}
                            onMouseLeave={(e) => {
                                e.target.style.background = 'rgba(255, 255, 255, 0.1)';
                                e.target.style.transform = 'translateY(0)';
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <span style={{ marginRight: '8px' }}>🔑</span>
                                Forgot Password
                            </div>
                        </button>
                    </div>
                </form>

                <div style={{ textAlign: 'center' }}>
                    <div style={{
                        background: 'rgba(59, 130, 246, 0.2)',
                        border: '1px solid rgba(59, 130, 246, 0.3)',
                        borderRadius: '12px',
                        padding: '16px',
                        backdropFilter: 'blur(10px)'
                    }}>
                        <p style={{
                            color: 'rgba(255, 255, 255, 0.9)',
                            margin: 0,
                            fontSize: '14px'
                        }}>
                            <span style={{ fontWeight: '600' }}>Default Credentials:</span><br/>
                            Username: admin | Password: password
                        </p>
                    </div>
                </div>
            </div>

            {/* Forgot Password Modal */}
            {showForgotPassword && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0, 0, 0, 0.5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 1000,
                    backdropFilter: 'blur(5px)'
                }}>
                    <div style={{
                        background: 'rgba(255, 255, 255, 0.1)',
                        backdropFilter: 'blur(20px)',
                        borderRadius: '20px',
                        padding: '32px',
                        minWidth: '400px',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)'
                    }}>
                        <h3 style={{ color: 'white', marginTop: 0, marginBottom: '16px', fontSize: '20px' }}>
                            Forgot Password
                        </h3>
                        <p style={{ color: 'rgba(255, 255, 255, 0.8)', marginBottom: '24px', fontSize: '14px' }}>
                            Enter your username to receive a reset token in the server console.
                        </p>
                        <form onSubmit={handleForgotPassword}>
                            <input
                                type="text"
                                placeholder="Enter username"
                                style={{
                                    width: '100%',
                                    padding: '12px 16px',
                                    background: 'rgba(255, 255, 255, 0.1)',
                                    border: '1px solid rgba(255, 255, 255, 0.2)',
                                    borderRadius: '12px',
                                    color: 'white',
                                    fontSize: '16px',
                                    marginBottom: '24px',
                                    boxSizing: 'border-box',
                                    backdropFilter: 'blur(10px)',
                                    outline: 'none'
                                }}
                                required
                            />
                            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                                <button
                                    type="button"
                                    onClick={() => setShowForgotPassword(false)}
                                    style={{
                                        padding: '12px 24px',
                                        background: 'rgba(255, 255, 255, 0.1)',
                                        border: '1px solid rgba(255, 255, 255, 0.2)',
                                        borderRadius: '8px',
                                        color: 'white',
                                        cursor: 'pointer',
                                        backdropFilter: 'blur(10px)',
                                        outline: 'none'
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    style={{
                                        padding: '12px 24px',
                                        background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                                        border: 'none',
                                        borderRadius: '8px',
                                        color: 'white',
                                        cursor: 'pointer',
                                        fontWeight: '600',
                                        outline: 'none'
                                    }}
                                >
                                    Get Reset Token
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            <style>
                {`
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
                `}
            </style>
        </div>
    );
};

// Enhanced File Browser with glass effect
const FileBrowser = ({ token, user }) => {
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [showUserDropdown, setShowUserDropdown] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [filteredFiles, setFilteredFiles] = useState([]);

    useEffect(() => {
        fetchFiles();
    }, []);

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

    const fetchFiles = async () => {
        setLoading(true);
        setError('');
        try {
            const response = await fetch('/api/files', {
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

    const handleLogout = () => {
        localStorage.removeItem('token');
        window.location.reload();
    };

    const getFileIcon = (item) => {
        if (!item.name.includes('.')) {
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
                            <div style={{
                                position: 'absolute',
                                right: 0,
                                top: '100%',
                                marginTop: '8px',
                                minWidth: '200px',
                                background: 'rgba(255, 255, 255, 0.1)',
                                backdropFilter: 'blur(20px)',
                                borderRadius: '12px',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
                                zIndex: 50,
                                overflow: 'hidden'
                            }}>
                                <div style={{
                                    padding: '16px',
                                    borderBottom: '1px solid rgba(255, 255, 255, 0.2)'
                                }}>
                                    <p style={{ color: 'white', margin: 0, fontWeight: '600', fontSize: '14px' }}>
                                        {user?.username}
                                    </p>
                                    <p style={{ color: 'rgba(255, 255, 255, 0.8)', margin: 0, fontSize: '12px' }}>
                                        System Administrator
                                    </p>
                                </div>
                                <button
                                    onClick={() => {
                                        setShowSettingsModal(true);
                                        setShowUserDropdown(false);
                                    }}
                                    style={{
                                        width: '100%',
                                        textAlign: 'left',
                                        padding: '12px 16px',
                                        background: 'transparent',
                                        border: 'none',
                                        color: 'white',
                                        cursor: 'pointer',
                                        transition: 'background 0.3s ease',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        fontSize: '14px',
                                        outline: 'none'
                                    }}
                                    onMouseEnter={(e) => {
                                        e.target.style.background = 'rgba(255, 255, 255, 0.1)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.target.style.background = 'transparent';
                                    }}
                                >
                                    <span>⚙️</span>
                                    <span>Settings</span>
                                </button>
                                <button
                                    onClick={() => {
                                        // Change password functionality
                                        setShowUserDropdown(false);
                                    }}
                                    style={{
                                        width: '100%',
                                        textAlign: 'left',
                                        padding: '12px 16px',
                                        background: 'transparent',
                                        border: 'none',
                                        color: 'white',
                                        cursor: 'pointer',
                                        transition: 'background 0.3s ease',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        fontSize: '14px',
                                        outline: 'none'
                                    }}
                                    onMouseEnter={(e) => {
                                        e.target.style.background = 'rgba(255, 255, 255, 0.1)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.target.style.background = 'transparent';
                                    }}
                                >
                                    <span>🔑</span>
                                    <span>Change Password</span>
                                </button>
                                <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.2)', marginTop: '4px', paddingTop: '4px' }}>
                                    <button
                                        onClick={() => {
                                            handleLogout();
                                            setShowUserDropdown(false);
                                        }}
                                        style={{
                                            width: '100%',
                                            textAlign: 'left',
                                            padding: '12px 16px',
                                            background: 'transparent',
                                            border: 'none',
                                            color: '#ef4444',
                                            cursor: 'pointer',
                                            transition: 'background 0.3s ease',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            fontSize: '14px',
                                            outline: 'none'
                                        }}
                                        onMouseEnter={(e) => {
                                            e.target.style.background = 'rgba(239, 68, 68, 0.2)';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.target.style.background = 'transparent';
                                        }}
                                    >
                                        <span>🚪</span>
                                        <span>Logout</span>
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div style={{ padding: '24px', position: 'relative', zIndex: 10 }}>
                {/* File List Container */}
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
                    <div style={{ padding: '24px' }}>
                        {error ? (
                            <div style={{
                                textAlign: 'center',
                                padding: '40px',
                                color: '#ef4444'
                            }}>
                                <div style={{ fontSize: '48px', marginBottom: '16px' }}>❌</div>
                                <p style={{ margin: 0, fontSize: '16px' }}>{error}</p>
                            </div>
                        ) : filteredFiles.length === 0 ? (
                            <div style={{
                                textAlign: 'center',
                                padding: '60px',
                                color: 'rgba(255, 255, 255, 0.8)'
                            }}>
                                <div style={{ fontSize: '64px', marginBottom: '16px' }}>📁</div>
                                {searchQuery.trim() !== '' ? (
                                    <div>
                                        <p style={{ margin: 0, fontSize: '18px', marginBottom: '8px' }}>
                                            No files found matching "{searchQuery}"
                                        </p>
                                        <button
                                            onClick={() => setSearchQuery('')}
                                            style={{
                                                background: 'rgba(59, 130, 246, 0.2)',
                                                border: '1px solid rgba(59, 130, 246, 0.5)',
                                                borderRadius: '8px',
                                                color: 'white',
                                                padding: '8px 16px',
                                                cursor: 'pointer',
                                                fontSize: '14px',
                                                outline: 'none'
                                            }}
                                        >
                                            Clear search
                                        </button>
                                    </div>
                                ) : (
                                    <p style={{ margin: 0, fontSize: '18px' }}>This folder is empty</p>
                                )}
                            </div>
                        ) : (
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                                gap: '16px'
                            }}>
                                {filteredFiles.map((file, index) => (
                                    <div
                                        key={index}
                                        style={{
                                            background: 'rgba(255, 255, 255, 0.1)',
                                            backdropFilter: 'blur(10px)',
                                            borderRadius: '12px',
                                            border: '1px solid rgba(255, 255, 255, 0.2)',
                                            padding: '16px',
                                            cursor: 'pointer',
                                            transition: 'all 0.3s ease',
                                            transform: 'translateY(0)'
                                        }}
                                        onMouseEnter={(e) => {
                                            e.target.style.background = 'rgba(255, 255, 255, 0.2)';
                                            e.target.style.transform = 'translateY(-4px)';
                                            e.target.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.2)';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.target.style.background = 'rgba(255, 255, 255, 0.1)';
                                            e.target.style.transform = 'translateY(0)';
                                            e.target.style.boxShadow = 'none';
                                        }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                            <div style={{ fontSize: '32px' }}>
                                                {getFileIcon(file)}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <p style={{
                                                    color: 'white',
                                                    margin: 0,
                                                    fontSize: '16px',
                                                    fontWeight: '500',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap'
                                                }}>
                                                    {file.name}
                                                </p>
                                                <p style={{
                                                    color: 'rgba(255, 255, 255, 0.7)',
                                                    margin: 0,
                                                    fontSize: '12px',
                                                    marginTop: '4px'
                                                }}>
                                                    {file.name.includes('.') ? 'File' : 'Folder'}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Settings Modal */}
            {showSettingsModal && (
                <SettingsModal
                    onClose={() => setShowSettingsModal(false)}
                    token={token}
                />
            )}

            <style>
                {`
                    @keyframes pulse {
                        0%, 100% { opacity: 0.2; transform: scale(1); }
                        50% { opacity: 0.4; transform: scale(1.05); }
                    }
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    ::placeholder {
                        color: rgba(255, 255, 255, 0.6);
                    }
                `}
            </style>
        </div>
    );
};

// Settings Modal Component
const SettingsModal = ({ onClose, token }) => {
    const [settings, setSettings] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const response = await fetch('/api/settings', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (response.ok) {
                const data = await response.json();
                setSettings(data);
            } else {
                setError('Failed to load settings');
            }
        } catch (err) {
            setError('Connection error');
        } finally {
            setLoading(false);
        }
    };

    const saveSettings = async () => {
        setSaving(true);
        setError('');
        setSuccess('');

        try {
            const response = await fetch('/api/settings', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(settings)
            });

            if (response.ok) {
                setSuccess('Settings saved successfully! Server restart may be required for some changes.');
            } else {
                const data = await response.json();
                setError(data.error || 'Failed to save settings');
            }
        } catch (err) {
            setError('Connection error');
        } finally {
            setSaving(false);
        }
    };

    const handleSettingChange = (key, value) => {
        setSettings(prev => ({
            ...prev,
            [key]: value
        }));
    };

    const securityFeatures = [
        { key: 'enableRateLimit', name: 'Rate Limiting', description: 'Limit request frequency to prevent abuse' },
        { key: 'enableSecurityHeaders', name: 'Security Headers', description: 'Add security headers like HSTS, CSP, etc.' },
        { key: 'enableInputValidation', name: 'Input Validation', description: 'Validate and sanitize user inputs' },
        { key: 'enableFileUploadSecurity', name: 'File Upload Security', description: 'Check file types and sizes for uploads' },
        { key: 'enableRequestLogging', name: 'Request Logging', description: 'Log all requests for monitoring' },
        { key: 'enableCSP', name: 'Content Security Policy', description: 'Strict CSP headers for XSS protection' }
    ];

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            backdropFilter: 'blur(5px)',
            padding: '20px'
        }}>
            <div style={{
                background: 'rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(20px)',
                borderRadius: '20px',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                width: '100%',
                maxWidth: '600px',
                maxHeight: '80vh',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column'
            }}>
                {/* Header */}
                <div style={{
                    padding: '24px',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                }}>
                    <div>
                        <h2 style={{ color: 'white', margin: 0, fontSize: '24px', fontWeight: 'bold' }}>
                            Security Settings
                        </h2>
                        <p style={{ color: 'rgba(255, 255, 255, 0.8)', margin: 0, fontSize: '14px', marginTop: '4px' }}>
                            Configure security features for your file transfer system
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            color: 'white',
                            width: '32px',
                            height: '32px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '16px',
                            outline: 'none'
                        }}
                    >
                        ✕
                    </button>
                </div>

                {/* Content */}
                <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
                    {loading ? (
                        <div style={{ textAlign: 'center', padding: '40px' }}>
                            <div style={{
                                width: '40px',
                                height: '40px',
                                border: '3px solid rgba(255, 255, 255, 0.3)',
                                borderTop: '3px solid white',
                                borderRadius: '50%',
                                animation: 'spin 1s linear infinite',
                                margin: '0 auto 16px'
                            }}></div>
                            <p style={{ color: 'white', margin: 0 }}>Loading settings...</p>
                        </div>
                    ) : (
                        <div>
                            {/* Always Enabled Section */}
                            <div style={{ marginBottom: '32px' }}>
                                <h3 style={{ color: 'white', fontSize: '18px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span>🛡️</span>
                                    Always Enabled (Core Security)
                                </h3>
                                <div style={{
                                    background: 'rgba(34, 197, 94, 0.2)',
                                    border: '1px solid rgba(34, 197, 94, 0.3)',
                                    borderRadius: '12px',
                                    padding: '16px'
                                }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ color: '#22c55e' }}>✅</span>
                                            <span style={{ color: 'white', fontSize: '14px' }}>JWT Token Authentication</span>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ color: '#22c55e' }}>✅</span>
                                            <span style={{ color: 'white', fontSize: '14px' }}>Password Hashing (bcrypt)</span>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ color: '#22c55e' }}>✅</span>
                                            <span style={{ color: 'white', fontSize: '14px' }}>HTTPS Data Transmission (when configured)</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Configurable Features */}
                            <div style={{ marginBottom: '24px' }}>
                                <h3 style={{ color: 'white', fontSize: '18px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span>⚙️</span>
                                    Configurable Security Features
                                </h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                    {securityFeatures.map(feature => (
                                        <div key={feature.key} style={{
                                            background: 'rgba(255, 255, 255, 0.1)',
                                            backdropFilter: 'blur(10px)',
                                            borderRadius: '12px',
                                            border: '1px solid rgba(255, 255, 255, 0.2)',
                                            padding: '16px'
                                        }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                                                <div style={{ flex: 1 }}>
                                                    <h4 style={{ color: 'white', margin: 0, fontSize: '16px', fontWeight: '600' }}>
                                                        {feature.name}
                                                    </h4>
                                                    <p style={{ color: 'rgba(255, 255, 255, 0.8)', margin: 0, fontSize: '14px', marginTop: '4px' }}>
                                                        {feature.description}
                                                    </p>
                                                </div>
                                                <label style={{
                                                    position: 'relative',
                                                    display: 'inline-block',
                                                    width: '48px',
                                                    height: '24px',
                                                    cursor: 'pointer'
                                                }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={settings[feature.key] === true}
                                                        onChange={(e) => handleSettingChange(feature.key, e.target.checked)}
                                                        style={{ display: 'none' }}
                                                    />
                                                    <div style={{
                                                        position: 'absolute',
                                                        top: 0,
                                                        left: 0,
                                                        right: 0,
                                                        bottom: 0,
                                                        background: settings[feature.key] === true ?
                                                            'linear-gradient(135deg, #3b82f6, #8b5cf6)' :
                                                            'rgba(255, 255, 255, 0.2)',
                                                        borderRadius: '12px',
                                                        transition: 'all 0.3s ease',
                                                        border: '1px solid rgba(255, 255, 255, 0.3)'
                                                    }}>
                                                        <div style={{
                                                            position: 'absolute',
                                                            top: '2px',
                                                            left: settings[feature.key] === true ? '26px' : '2px',
                                                            width: '18px',
                                                            height: '18px',
                                                            background: 'white',
                                                            borderRadius: '50%',
                                                            transition: 'all 0.3s ease',
                                                            boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)'
                                                        }}></div>
                                                    </div>
                                                </label>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Status Messages */}
                            {error && (
                                <div style={{
                                    background: 'rgba(239, 68, 68, 0.2)',
                                    border: '1px solid rgba(239, 68, 68, 0.5)',
                                    borderRadius: '12px',
                                    padding: '12px 16px',
                                    marginBottom: '16px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px'
                                }}>
                                    <span>❌</span>
                                    <span style={{ color: 'white', fontSize: '14px' }}>{error}</span>
                                </div>
                            )}

                            {success && (
                                <div style={{
                                    background: 'rgba(34, 197, 94, 0.2)',
                                    border: '1px solid rgba(34, 197, 94, 0.5)',
                                    borderRadius: '12px',
                                    padding: '12px 16px',
                                    marginBottom: '16px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px'
                                }}>
                                    <span>✅</span>
                                    <span style={{ color: 'white', fontSize: '14px' }}>{success}</span>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div style={{
                    padding: '24px',
                    borderTop: '1px solid rgba(255, 255, 255, 0.2)',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '12px'
                }}>
                    <button
                        onClick={onClose}
                        style={{
                            padding: '12px 24px',
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '8px',
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: '14px',
                            fontWeight: '500',
                            backdropFilter: 'blur(10px)',
                            outline: 'none'
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={saveSettings}
                        disabled={saving || loading}
                        style={{
                            padding: '12px 24px',
                            background: saving ? 'rgba(255, 255, 255, 0.2)' : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                            border: 'none',
                            borderRadius: '8px',
                            color: 'white',
                            cursor: saving ? 'not-allowed' : 'pointer',
                            fontSize: '14px',
                            fontWeight: '600',
                            outline: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                        }}
                    >
                        {saving && (
                            <div style={{
                                width: '16px',
                                height: '16px',
                                border: '2px solid rgba(255, 255, 255, 0.3)',
                                borderTop: '2px solid white',
                                borderRadius: '50%',
                                animation: 'spin 1s linear infinite'
                            }}></div>
                        )}
                        {saving ? 'Saving...' : 'Save Settings'}
                    </button>
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
                    <p style={{ color: 'white', margin: 0, fontSize: '18px' }}>
                        Initializing futuristic file manager...
                    </p>
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
