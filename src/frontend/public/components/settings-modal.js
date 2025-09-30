// Settings Modal Component
const SettingsModal = ({ onClose, token }) => {
    const [settings, setSettings] = useState({});
<<<<<<< HEAD
=======
    const [users, setUsers] = useState([]);
    const [userStats, setUserStats] = useState(null);
    const [config, setConfig] = useState({});
>>>>>>> 7418473 (Implement comprehensive User Management and Configuration Editing features)
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [showCreateUser, setShowCreateUser] = useState(false);
    const [editingUser, setEditingUser] = useState(null);
    const [configSection, setConfigSection] = useState('server');

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
<<<<<<< HEAD
                setError('Failed to load settings');
=======
                throw new Error('Failed to load settings');
            }
        } catch (err) {
            setError('Failed to load settings');
        }
    };

    const fetchUsers = async () => {
        try {
            const response = await fetch('/api/admin/users', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (response.ok) {
                const data = await response.json();
                setUsers(data.users || []);
                setUserStats(data.stats || null);
            } else {
                throw new Error('Failed to load users');
            }
        } catch (err) {
            console.warn('Failed to load users:', err);
        }
    };

    const createUser = async (userData) => {
        try {
            setSaving(true);
            setError('');
            
            const response = await fetch('/api/admin/users', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(userData)
            });

            if (response.ok) {
                const data = await response.json();
                setSuccess(data.message);
                setShowCreateUser(false);
                await fetchUsers();
            } else {
                const data = await response.json();
                setError(data.error || 'Failed to create user');
            }
        } catch (err) {
            setError('Failed to create user');
        } finally {
            setSaving(false);
        }
    };

    const updateUser = async (username, updates) => {
        try {
            setSaving(true);
            setError('');
            
            const response = await fetch(`/api/admin/users/${username}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(updates)
            });

            if (response.ok) {
                const data = await response.json();
                setSuccess(data.message);
                setEditingUser(null);
                await fetchUsers();
            } else {
                const data = await response.json();
                setError(data.error || 'Failed to update user');
            }
        } catch (err) {
            setError('Failed to update user');
        } finally {
            setSaving(false);
        }
    };

    const deleteUser = async (username) => {
        if (!window.confirm(`Are you sure you want to delete user "${username}"?`)) {
            return;
        }

        try {
            setSaving(true);
            setError('');
            
            const response = await fetch(`/api/admin/users/${username}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (response.ok) {
                const data = await response.json();
                setSuccess(data.message);
                await fetchUsers();
            } else {
                const data = await response.json();
                setError(data.error || 'Failed to delete user');
            }
        } catch (err) {
            setError('Failed to delete user');
        } finally {
            setSaving(false);
        }
    };

    const saveConfig = async (configData) => {
        try {
            setSaving(true);
            setError('');
            
            const response = await fetch('/api/admin/config', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(configData)
            });

            if (response.ok) {
                const data = await response.json();
                setSuccess(data.message);
                if (data.needsRestart) {
                    setError('Server restart may be required for some changes to take effect.');
                }
                await fetchConfig();
            } else {
                const data = await response.json();
                setError(data.error || 'Failed to save configuration');
            }
        } catch (err) {
            setError('Failed to save configuration');
        } finally {
            setSaving(false);
        }
    };

    const fetchConfig = async () => {
        try {
            const response = await fetch('/api/admin/config', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (response.ok) {
                const data = await response.json();
                setConfig(data);
            } else {
                throw new Error('Failed to load config');
>>>>>>> 7418473 (Implement comprehensive User Management and Configuration Editing features)
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
                            outline: 'none',
                            transition: 'all 0.3s ease'
                        }}
                        onMouseEnter={(e) => {
                            e.target.style.background = 'rgba(255, 255, 255, 0.2)';
                        }}
                        onMouseLeave={(e) => {
                            e.target.style.background = 'rgba(255, 255, 255, 0.1)';
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
                                    padding: '16px',
                                    backdropFilter: 'blur(10px)'
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
                                        <SecurityFeatureToggle
                                            key={feature.key}
                                            feature={feature}
                                            enabled={settings[feature.key] === true}
                                            onChange={(value) => handleSettingChange(feature.key, value)}
                                        />
                                    ))}
                                </div>
                            </div>

<<<<<<< HEAD
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
                                    gap: '8px',
                                    backdropFilter: 'blur(10px)'
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
                                    gap: '8px',
                                    backdropFilter: 'blur(10px)'
                                }}>
                                    <span>✅</span>
                                    <span style={{ color: 'white', fontSize: '14px' }}>{success}</span>
=======
                            {/* Users Tab */}
                            {activeTab === 'users' && (
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                        <h3 style={{ color: 'white', marginTop: 0, marginBottom: 0 }}>User Management</h3>
                                        <button
                                            onClick={() => setShowCreateUser(true)}
                                            style={{
                                                background: 'linear-gradient(135deg, #34d399, #10b981)',
                                                border: 'none',
                                                borderRadius: '8px',
                                                color: 'white',
                                                padding: '8px 16px',
                                                cursor: 'pointer',
                                                fontSize: '14px',
                                                fontWeight: 'bold',
                                                outline: 'none'
                                            }}
                                        >
                                            + Create User
                                        </button>
                                    </div>

                                    {/* User Statistics */}
                                    {userStats && (
                                        <div style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                                            gap: '12px',
                                            marginBottom: '20px'
                                        }}>
                                            <div style={{
                                                background: 'rgba(59, 130, 246, 0.2)',
                                                padding: '12px',
                                                borderRadius: '8px',
                                                textAlign: 'center'
                                            }}>
                                                <div style={{ color: '#60a5fa', fontSize: '24px', fontWeight: 'bold' }}>{userStats.total}</div>
                                                <div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '12px' }}>Total Users</div>
                                            </div>
                                            <div style={{
                                                background: 'rgba(34, 197, 94, 0.2)',
                                                padding: '12px',
                                                borderRadius: '8px',
                                                textAlign: 'center'
                                            }}>
                                                <div style={{ color: '#4ade80', fontSize: '24px', fontWeight: 'bold' }}>{userStats.active}</div>
                                                <div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '12px' }}>Active</div>
                                            </div>
                                            <div style={{
                                                background: 'rgba(239, 68, 68, 0.2)',
                                                padding: '12px',
                                                borderRadius: '8px',
                                                textAlign: 'center'
                                            }}>
                                                <div style={{ color: '#f87171', fontSize: '24px', fontWeight: 'bold' }}>{userStats.admins}</div>
                                                <div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '12px' }}>Admins</div>
                                            </div>
                                            <div style={{
                                                background: 'rgba(168, 85, 247, 0.2)',
                                                padding: '12px',
                                                borderRadius: '8px',
                                                textAlign: 'center'
                                            }}>
                                                <div style={{ color: '#a78bfa', fontSize: '24px', fontWeight: 'bold' }}>{userStats.recentLogins}</div>
                                                <div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '12px' }}>Recent Logins</div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Users List */}
                                    <div style={{
                                        background: 'rgba(255, 255, 255, 0.05)',
                                        border: '1px solid rgba(255, 255, 255, 0.1)',
                                        borderRadius: '12px',
                                        overflow: 'hidden'
                                    }}>
                                        {users.length > 0 ? (
                                            <div>
                                                {users.map(user => (
                                                    <div
                                                        key={user.id}
                                                        style={{
                                                            display: 'flex',
                                                            justifyContent: 'space-between',
                                                            alignItems: 'center',
                                                            padding: '16px',
                                                            borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
                                                        }}
                                                    >
                                                        <div style={{ flex: 1 }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                                                <span style={{ color: 'white', fontWeight: 'bold' }}>{user.username}</span>
                                                                <span style={{
                                                                    padding: '2px 8px',
                                                                    borderRadius: '12px',
                                                                    fontSize: '10px',
                                                                    background: user.role === 'admin' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(34, 197, 94, 0.3)',
                                                                    color: user.role === 'admin' ? '#fca5a5' : '#86efac'
                                                                }}>
                                                                    {user.role}
                                                                </span>
                                                                {!user.active && (
                                                                    <span style={{
                                                                        padding: '2px 8px',
                                                                        borderRadius: '12px',
                                                                        fontSize: '10px',
                                                                        background: 'rgba(107, 114, 128, 0.3)',
                                                                        color: '#9ca3af'
                                                                    }}>
                                                                        INACTIVE
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '12px' }}>
                                                                {user.email} | Created: {new Date(user.created).toLocaleDateString()}
                                                                {user.lastLogin && ` | Last login: ${new Date(user.lastLogin).toLocaleDateString()}`}
                                                            </div>
                                                        </div>
                                                        <div style={{ display: 'flex', gap: '8px' }}>
                                                            <button
                                                                onClick={() => setEditingUser(user)}
                                                                style={{
                                                                    background: 'rgba(59, 130, 246, 0.2)',
                                                                    border: '1px solid rgba(59, 130, 246, 0.5)',
                                                                    borderRadius: '6px',
                                                                    color: '#60a5fa',
                                                                    padding: '4px 8px',
                                                                    cursor: 'pointer',
                                                                    fontSize: '12px'
                                                                }}
                                                            >
                                                                Edit
                                                            </button>
                                                            {user.username !== 'admin' && (
                                                                <button
                                                                    onClick={() => deleteUser(user.username)}
                                                                    style={{
                                                                        background: 'rgba(239, 68, 68, 0.2)',
                                                                        border: '1px solid rgba(239, 68, 68, 0.5)',
                                                                        borderRadius: '6px',
                                                                        color: '#f87171',
                                                                        padding: '4px 8px',
                                                                        cursor: 'pointer',
                                                                        fontSize: '12px'
                                                                    }}
                                                                >
                                                                    Delete
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <div style={{ color: 'rgba(255, 255, 255, 0.7)', textAlign: 'center', padding: '40px' }}>
                                                No users found
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Config Tab */}
                            {activeTab === 'config' && (
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                        <h3 style={{ color: 'white', marginTop: 0, marginBottom: 0 }}>Configuration</h3>
                                        <div style={{ display: 'flex', gap: '8px' }}>
                                            <button
                                                onClick={() => window.open('/api/admin/config/backup', '_blank')}
                                                style={{
                                                    background: 'rgba(168, 85, 247, 0.2)',
                                                    border: '1px solid rgba(168, 85, 247, 0.5)',
                                                    borderRadius: '6px',
                                                    color: '#a78bfa',
                                                    padding: '6px 12px',
                                                    cursor: 'pointer',
                                                    fontSize: '12px'
                                                }}
                                            >
                                                📥 Backup
                                            </button>
                                            <select
                                                value={configSection}
                                                onChange={(e) => setConfigSection(e.target.value)}
                                                style={{
                                                    background: 'rgba(255, 255, 255, 0.1)',
                                                    border: '1px solid rgba(255, 255, 255, 0.2)',
                                                    borderRadius: '6px',
                                                    color: 'white',
                                                    padding: '6px 12px',
                                                    fontSize: '12px'
                                                }}
                                            >
                                                <option value="server">Server</option>
                                                <option value="filesystem">File System</option>
                                                <option value="security">Security</option>
                                                <option value="logging">Logging</option>
                                                <option value="auth">Authentication</option>
                                            </select>
                                        </div>
                                    </div>

                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        {/* Server Config */}
                                        {configSection === 'server' && (
                                            <div style={{
                                                background: 'rgba(255, 255, 255, 0.05)',
                                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                                borderRadius: '12px',
                                                padding: '16px'
                                            }}>
                                                <h4 style={{ color: 'white', marginTop: 0, marginBottom: '12px' }}>Server Settings</h4>
                                                <div style={{ display: 'grid', gap: '12px' }}>
                                                    <div>
                                                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Port:</label>
                                                        <input
                                                            type="number"
                                                            min="1"
                                                            max="65535"
                                                            value={config.server?.port || 3000}
                                                            onChange={(e) => setConfig(prev => ({
                                                                ...prev,
                                                                server: { ...prev.server, port: parseInt(e.target.value) }
                                                            }))}
                                                            style={{
                                                                background: 'rgba(255, 255, 255, 0.1)',
                                                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                                                borderRadius: '6px',
                                                                color: 'white',
                                                                padding: '8px 12px',
                                                                width: '100px'
                                                            }}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Host:</label>
                                                        <input
                                                            type="text"
                                                            value={config.server?.host || 'localhost'}
                                                            onChange={(e) => setConfig(prev => ({
                                                                ...prev,
                                                                server: { ...prev.server, host: e.target.value }
                                                            }))}
                                                            style={{
                                                                background: 'rgba(255, 255, 255, 0.1)',
                                                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                                                borderRadius: '6px',
                                                                color: 'white',
                                                                padding: '8px 12px',
                                                                width: '200px'
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* File System Config */}
                                        {configSection === 'filesystem' && (
                                            <div style={{
                                                background: 'rgba(255, 255, 255, 0.05)',
                                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                                borderRadius: '12px',
                                                padding: '16px'
                                            }}>
                                                <h4 style={{ color: 'white', marginTop: 0, marginBottom: '12px' }}>File System Settings</h4>
                                                <div style={{ display: 'grid', gap: '12px' }}>
                                                    <div>
                                                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Storage Path:</label>
                                                        <input
                                                            type="text"
                                                            value={config.fileSystem?.storagePath || './storage'}
                                                            onChange={(e) => setConfig(prev => ({
                                                                ...prev,
                                                                fileSystem: { ...prev.fileSystem, storagePath: e.target.value }
                                                            }))}
                                                            style={{
                                                                background: 'rgba(255, 255, 255, 0.1)',
                                                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                                                borderRadius: '6px',
                                                                color: 'white',
                                                                padding: '8px 12px',
                                                                width: '300px'
                                                            }}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Max File Size (bytes):</label>
                                                        <input
                                                            type="number"
                                                            min="1024"
                                                            value={config.fileSystem?.maxFileSize || 104857600}
                                                            onChange={(e) => setConfig(prev => ({
                                                                ...prev,
                                                                fileSystem: { ...prev.fileSystem, maxFileSize: parseInt(e.target.value) }
                                                            }))}
                                                            style={{
                                                                background: 'rgba(255, 255, 255, 0.1)',
                                                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                                                borderRadius: '6px',
                                                                color: 'white',
                                                                padding: '8px 12px',
                                                                width: '150px'
                                                            }}
                                                        />
                                                        <div style={{ color: 'rgba(255, 255, 255, 0.6)', fontSize: '12px', marginTop: '4px' }}>
                                                            {Math.round((config.fileSystem?.maxFileSize || 104857600) / 1024 / 1024)} MB
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* Security Config */}
                                        {configSection === 'security' && (
                                            <div style={{
                                                background: 'rgba(255, 255, 255, 0.05)',
                                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                                borderRadius: '12px',
                                                padding: '16px'
                                            }}>
                                                <h4 style={{ color: 'white', marginTop: 0, marginBottom: '12px' }}>Security Settings</h4>
                                                <div style={{ display: 'grid', gap: '12px' }}>
                                                    {Object.entries(config.security || {}).map(([key, value]) => (
                                                        <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                            <span style={{ color: 'white', fontSize: '14px' }}>
                                                                {key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
                                                            </span>
                                                            <label style={{ position: 'relative', display: 'inline-block', width: '40px', height: '20px' }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={value}
                                                                    onChange={(e) => setConfig(prev => ({
                                                                        ...prev,
                                                                        security: { ...prev.security, [key]: e.target.checked }
                                                                    }))}
                                                                    style={{ opacity: 0, width: 0, height: 0 }}
                                                                />
                                                                <span style={{
                                                                    position: 'absolute',
                                                                    cursor: 'pointer',
                                                                    top: 0,
                                                                    left: 0,
                                                                    right: 0,
                                                                    bottom: 0,
                                                                    backgroundColor: value ? '#3b82f6' : 'rgba(255, 255, 255, 0.2)',
                                                                    transition: '0.4s',
                                                                    borderRadius: '20px'
                                                                }} />
                                                            </label>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Logging Config */}
                                        {configSection === 'logging' && (
                                            <div style={{
                                                background: 'rgba(255, 255, 255, 0.05)',
                                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                                borderRadius: '12px',
                                                padding: '16px'
                                            }}>
                                                <h4 style={{ color: 'white', marginTop: 0, marginBottom: '12px' }}>Logging Settings</h4>
                                                <div style={{ display: 'grid', gap: '12px' }}>
                                                    <div>
                                                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Log Level:</label>
                                                        <select
                                                            value={config.logging?.logLevel || 'info'}
                                                            onChange={(e) => setConfig(prev => ({
                                                                ...prev,
                                                                logging: { ...prev.logging, logLevel: e.target.value }
                                                            }))}
                                                            style={{
                                                                background: 'rgba(255, 255, 255, 0.1)',
                                                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                                                borderRadius: '6px',
                                                                color: 'white',
                                                                padding: '8px 12px'
                                                            }}
                                                        >
                                                            <option value="error">Error</option>
                                                            <option value="warn">Warning</option>
                                                            <option value="info">Info</option>
                                                            <option value="debug">Debug</option>
                                                        </select>
                                                    </div>
                                                    {Object.entries(config.logging || {}).filter(([key]) => key !== 'logLevel').map(([key, value]) => (
                                                        <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                            <span style={{ color: 'white', fontSize: '14px' }}>
                                                                {key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
                                                            </span>
                                                            <label style={{ position: 'relative', display: 'inline-block', width: '40px', height: '20px' }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={value}
                                                                    onChange={(e) => setConfig(prev => ({
                                                                        ...prev,
                                                                        logging: { ...prev.logging, [key]: e.target.checked }
                                                                    }))}
                                                                    style={{ opacity: 0, width: 0, height: 0 }}
                                                                />
                                                                <span style={{
                                                                    position: 'absolute',
                                                                    cursor: 'pointer',
                                                                    top: 0,
                                                                    left: 0,
                                                                    right: 0,
                                                                    bottom: 0,
                                                                    backgroundColor: value ? '#3b82f6' : 'rgba(255, 255, 255, 0.2)',
                                                                    transition: '0.4s',
                                                                    borderRadius: '20px'
                                                                }} />
                                                            </label>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Auth Config */}
                                        {configSection === 'auth' && (
                                            <div style={{
                                                background: 'rgba(255, 255, 255, 0.05)',
                                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                                borderRadius: '12px',
                                                padding: '16px'
                                            }}>
                                                <h4 style={{ color: 'white', marginTop: 0, marginBottom: '12px' }}>Authentication Settings</h4>
                                                <div style={{ display: 'grid', gap: '12px' }}>
                                                    <div>
                                                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Default Admin Username:</label>
                                                        <input
                                                            type="text"
                                                            value={config.auth?.username || 'admin'}
                                                            onChange={(e) => setConfig(prev => ({
                                                                ...prev,
                                                                auth: { ...prev.auth, username: e.target.value }
                                                            }))}
                                                            style={{
                                                                background: 'rgba(255, 255, 255, 0.1)',
                                                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                                                borderRadius: '6px',
                                                                color: 'white',
                                                                padding: '8px 12px',
                                                                width: '200px'
                                                            }}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>JWT Secret Status:</label>
                                                        <div style={{ color: 'rgba(255, 255, 255, 0.7)' }}>
                                                            {config.auth?.jwtSecret || '[DEFAULT]'}
                                                            {config.auth?.jwtSecret === '[DEFAULT]' && (
                                                                <div style={{ color: '#f87171', fontSize: '12px', marginTop: '4px' }}>
                                                                    ⚠️ Using default JWT secret. Consider setting a custom one for security.
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* Save Button */}
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '20px' }}>
                                            <button
                                                onClick={() => saveConfig(config)}
                                                disabled={saving}
                                                style={{
                                                    background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
                                                    border: 'none',
                                                    borderRadius: '8px',
                                                    color: 'white',
                                                    padding: '12px 24px',
                                                    cursor: saving ? 'not-allowed' : 'pointer',
                                                    opacity: saving ? 0.7 : 1,
                                                    fontWeight: 'bold',
                                                    outline: 'none',
                                                    transition: 'all 0.3s ease'
                                                }}
                                            >
                                                {saving ? 'Saving...' : 'Save Configuration'}
                                            </button>
                                        </div>
                                    </div>
>>>>>>> 7418473 (Implement comprehensive User Management and Configuration Editing features)
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
                            outline: 'none',
                            transition: 'all 0.3s ease'
                        }}
                        onMouseEnter={(e) => {
                            e.target.style.background = 'rgba(255, 255, 255, 0.2)';
                        }}
                        onMouseLeave={(e) => {
                            e.target.style.background = 'rgba(255, 255, 255, 0.1)';
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
                            gap: '8px',
                            transition: 'all 0.3s ease'
                        }}
                        onMouseEnter={(e) => {
                            if (!saving) {
                                e.target.style.transform = 'translateY(-1px)';
                                e.target.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.2)';
                            }
                        }}
                        onMouseLeave={(e) => {
                            e.target.style.transform = 'translateY(0)';
                            e.target.style.boxShadow = 'none';
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

            {/* Create User Modal */}
            {showCreateUser && (
                <CreateUserModal
                    onClose={() => setShowCreateUser(false)}
                    onSubmit={createUser}
                    loading={saving}
                />
            )}

            {/* Edit User Modal */}
            {editingUser && (
                <EditUserModal
                    user={editingUser}
                    onClose={() => setEditingUser(null)}
                    onSubmit={updateUser}
                    loading={saving}
                />
            )}
        </div>
    );
};

// Create User Modal Component
const CreateUserModal = ({ onClose, onSubmit, loading }) => {
    const [formData, setFormData] = useState({
        username: '',
        password: '',
        email: '',
        role: 'user',
        permissions: []
    });

    const handleSubmit = (e) => {
        e.preventDefault();
        onSubmit(formData);
    };

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000
        }}>
            <div style={{
                background: 'rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(20px)',
                borderRadius: '16px',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                padding: '24px',
                width: '400px',
                maxWidth: '90vw'
            }}>
                <h3 style={{ color: 'white', marginTop: 0, marginBottom: '20px' }}>Create New User</h3>
                
                <form onSubmit={handleSubmit}>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Username:</label>
                        <input
                            type="text"
                            required
                            value={formData.username}
                            onChange={(e) => setFormData(prev => ({ ...prev, username: e.target.value }))}
                            style={{
                                width: '100%',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 12px'
                            }}
                        />
                    </div>

                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Password:</label>
                        <input
                            type="password"
                            required
                            value={formData.password}
                            onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                            style={{
                                width: '100%',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 12px'
                            }}
                        />
                    </div>

                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Email:</label>
                        <input
                            type="email"
                            value={formData.email}
                            onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                            style={{
                                width: '100%',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 12px'
                            }}
                        />
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Role:</label>
                        <select
                            value={formData.role}
                            onChange={(e) => setFormData(prev => ({ ...prev, role: e.target.value }))}
                            style={{
                                width: '100%',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 12px'
                            }}
                        >
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                        </select>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                        <button
                            type="button"
                            onClick={onClose}
                            style={{
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 16px',
                                cursor: 'pointer'
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={loading}
                            style={{
                                background: 'linear-gradient(135deg, #34d399, #10b981)',
                                border: 'none',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 16px',
                                cursor: loading ? 'not-allowed' : 'pointer',
                                opacity: loading ? 0.7 : 1
                            }}
                        >
                            {loading ? 'Creating...' : 'Create User'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

// Edit User Modal Component
const EditUserModal = ({ user, onClose, onSubmit, loading }) => {
    const [formData, setFormData] = useState({
        role: user.role,
        active: user.active,
        email: user.email || '',
        newPassword: ''
    });

    const handleSubmit = (e) => {
        e.preventDefault();
        const updates = { ...formData };
        if (!updates.newPassword) {
            delete updates.newPassword;
        } else {
            updates.password = updates.newPassword;
            delete updates.newPassword;
        }
        onSubmit(user.username, updates);
    };

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000
        }}>
            <div style={{
                background: 'rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(20px)',
                borderRadius: '16px',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                padding: '24px',
                width: '400px',
                maxWidth: '90vw'
            }}>
                <h3 style={{ color: 'white', marginTop: 0, marginBottom: '20px' }}>Edit User: {user.username}</h3>
                
                <form onSubmit={handleSubmit}>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Email:</label>
                        <input
                            type="email"
                            value={formData.email}
                            onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                            style={{
                                width: '100%',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 12px'
                            }}
                        />
                    </div>

                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Role:</label>
                        <select
                            value={formData.role}
                            onChange={(e) => setFormData(prev => ({ ...prev, role: e.target.value }))}
                            disabled={user.username === 'admin'}
                            style={{
                                width: '100%',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 12px',
                                opacity: user.username === 'admin' ? 0.5 : 1
                            }}
                        >
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                        </select>
                    </div>

                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                                type="checkbox"
                                checked={formData.active}
                                onChange={(e) => setFormData(prev => ({ ...prev, active: e.target.checked }))}
                                disabled={user.username === 'admin'}
                                style={{ opacity: user.username === 'admin' ? 0.5 : 1 }}
                            />
                            Active User
                        </label>
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>
                            New Password (leave blank to keep current):
                        </label>
                        <input
                            type="password"
                            value={formData.newPassword}
                            onChange={(e) => setFormData(prev => ({ ...prev, newPassword: e.target.value }))}
                            style={{
                                width: '100%',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 12px'
                            }}
                        />
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                        <button
                            type="button"
                            onClick={onClose}
                            style={{
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 16px',
                                cursor: 'pointer'
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={loading}
                            style={{
                                background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
                                border: 'none',
                                borderRadius: '6px',
                                color: 'white',
                                padding: '8px 16px',
                                cursor: loading ? 'not-allowed' : 'pointer',
                                opacity: loading ? 0.7 : 1
                            }}
                        >
                            {loading ? 'Updating...' : 'Update User'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
