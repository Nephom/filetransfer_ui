// Enhanced Admin Panel Component with Settings, Users, and Config Management
const { useState, useEffect } = React;

const AdminPanel = ({ onClose, token }) => {
    const [activeTab, setActiveTab] = useState('settings');
    const [settings, setSettings] = useState({});
    const [users, setUsers] = useState([]);
    const [config, setConfig] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    useEffect(() => {
        fetchAllData();
    }, []);

    const fetchAllData = async () => {
        setLoading(true);
        try {
            await Promise.all([
                fetchSettings(),
                fetchUsers(), 
                fetchConfig()
            ]);
        } catch (err) {
            setError('Failed to load admin data');
        } finally {
            setLoading(false);
        }
    };

    const fetchSettings = async () => {
        try {
            const response = await fetch('/api/settings', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (response.ok) {
                const data = await response.json();
                setSettings(data);
            } else {
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
            } else {
                throw new Error('Failed to load users');
            }
        } catch (err) {
            console.warn('Failed to load users:', err);
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
            }
        } catch (err) {
            console.warn('Failed to load config:', err);
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

    const tabs = [
        { id: 'settings', label: '🔒 Security Settings', icon: '🔒' },
        { id: 'users', label: '👥 User Management', icon: '👥' },
        { id: 'config', label: '⚙️ Configuration', icon: '⚙️' }
    ];

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
                maxWidth: '900px',
                maxHeight: '90vh',
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
                            Admin Panel
                        </h2>
                        <p style={{ color: 'rgba(255, 255, 255, 0.8)', margin: 0, fontSize: '14px', marginTop: '4px' }}>
                            System administration and configuration
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

                {/* Tabs */}
                <div style={{
                    display: 'flex',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
                    background: 'rgba(0, 0, 0, 0.1)'
                }}>
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            style={{
                                padding: '12px 20px',
                                background: activeTab === tab.id ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
                                border: 'none',
                                color: activeTab === tab.id ? 'white' : 'rgba(255, 255, 255, 0.7)',
                                cursor: 'pointer',
                                borderBottom: activeTab === tab.id ? '2px solid #3b82f6' : '2px solid transparent',
                                transition: 'all 0.3s ease',
                                fontSize: '14px',
                                fontWeight: activeTab === tab.id ? 'bold' : 'normal'
                            }}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div style={{
                    flex: 1,
                    padding: '24px',
                    overflow: 'auto'
                }}>
                    {loading ? (
                        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px' }}>
                            <div style={{ color: 'white', fontSize: '16px' }}>Loading...</div>
                        </div>
                    ) : (
                        <>
                            {/* Error/Success Messages */}
                            {error && (
                                <div style={{
                                    background: 'rgba(239, 68, 68, 0.2)',
                                    border: '1px solid rgba(239, 68, 68, 0.3)',
                                    borderRadius: '8px',
                                    padding: '12px',
                                    color: '#fca5a5',
                                    marginBottom: '16px'
                                }}>
                                    {error}
                                </div>
                            )}

                            {success && (
                                <div style={{
                                    background: 'rgba(34, 197, 94, 0.2)',
                                    border: '1px solid rgba(34, 197, 94, 0.3)',
                                    borderRadius: '8px',
                                    padding: '12px',
                                    color: '#86efac',
                                    marginBottom: '16px'
                                }}>
                                    {success}
                                </div>
                            )}

                            {/* Settings Tab */}
                            {activeTab === 'settings' && (
                                <div>
                                    <h3 style={{ color: 'white', marginTop: 0, marginBottom: '20px' }}>Security Settings</h3>
                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        {securityFeatures.map(feature => (
                                            <div
                                                key={feature.key}
                                                style={{
                                                    background: 'rgba(255, 255, 255, 0.05)',
                                                    border: '1px solid rgba(255, 255, 255, 0.1)',
                                                    borderRadius: '12px',
                                                    padding: '16px',
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    alignItems: 'center'
                                                }}
                                            >
                                                <div>
                                                    <div style={{ color: 'white', fontWeight: 'bold', marginBottom: '4px' }}>
                                                        {feature.name}
                                                    </div>
                                                    <div style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '14px' }}>
                                                        {feature.description}
                                                    </div>
                                                </div>
                                                <label style={{
                                                    position: 'relative',
                                                    display: 'inline-block',
                                                    width: '50px',
                                                    height: '28px'
                                                }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={settings[feature.key] || false}
                                                        onChange={(e) => handleSettingChange(feature.key, e.target.checked)}
                                                        style={{
                                                            opacity: 0,
                                                            width: 0,
                                                            height: 0
                                                        }}
                                                    />
                                                    <span style={{
                                                        position: 'absolute',
                                                        cursor: 'pointer',
                                                        top: 0,
                                                        left: 0,
                                                        right: 0,
                                                        bottom: 0,
                                                        backgroundColor: settings[feature.key] ? '#3b82f6' : 'rgba(255, 255, 255, 0.2)',
                                                        transition: '0.4s',
                                                        borderRadius: '28px'
                                                    }} />
                                                </label>
                                            </div>
                                        ))}
                                    </div>

                                    <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                                        <button
                                            onClick={saveSettings}
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
                                            {saving ? 'Saving...' : 'Save Settings'}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Users Tab */}
                            {activeTab === 'users' && (
                                <div>
                                    <h3 style={{ color: 'white', marginTop: 0, marginBottom: '20px' }}>User Management</h3>
                                    <div style={{
                                        background: 'rgba(255, 255, 255, 0.05)',
                                        border: '1px solid rgba(255, 255, 255, 0.1)',
                                        borderRadius: '12px',
                                        padding: '16px'
                                    }}>
                                        <h4 style={{ color: 'white', marginTop: 0 }}>Current Users</h4>
                                        {users.length > 0 ? (
                                            <div style={{ display: 'grid', gap: '8px' }}>
                                                {users.map(user => (
                                                    <div
                                                        key={user.id}
                                                        style={{
                                                            display: 'flex',
                                                            justifyContent: 'space-between',
                                                            alignItems: 'center',
                                                            padding: '12px',
                                                            background: 'rgba(255, 255, 255, 0.05)',
                                                            borderRadius: '8px'
                                                        }}
                                                    >
                                                        <div>
                                                            <div style={{ color: 'white', fontWeight: 'bold' }}>{user.username}</div>
                                                            <div style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '12px' }}>
                                                                Role: {user.role} | Status: {user.active ? 'Active' : 'Inactive'}
                                                            </div>
                                                        </div>
                                                        <div style={{
                                                            padding: '4px 8px',
                                                            borderRadius: '4px',
                                                            background: user.role === 'admin' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(34, 197, 94, 0.2)',
                                                            color: user.role === 'admin' ? '#fca5a5' : '#86efac',
                                                            fontSize: '12px'
                                                        }}>
                                                            {user.role}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <div style={{ color: 'rgba(255, 255, 255, 0.7)', textAlign: 'center', padding: '20px' }}>
                                                No users found
                                            </div>
                                        )}
                                        <div style={{ marginTop: '16px', textAlign: 'center' }}>
                                            <div style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '14px' }}>
                                                User management features will be available in a future update
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Config Tab */}
                            {activeTab === 'config' && (
                                <div>
                                    <h3 style={{ color: 'white', marginTop: 0, marginBottom: '20px' }}>Configuration</h3>
                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        {/* Server Config */}
                                        <div style={{
                                            background: 'rgba(255, 255, 255, 0.05)',
                                            border: '1px solid rgba(255, 255, 255, 0.1)',
                                            borderRadius: '12px',
                                            padding: '16px'
                                        }}>
                                            <h4 style={{ color: 'white', marginTop: 0, marginBottom: '12px' }}>Server Settings</h4>
                                            <div style={{ display: 'grid', gap: '8px' }}>
                                                <div>
                                                    <label style={{ color: 'white', display: 'block', marginBottom: '4px' }}>Port:</label>
                                                    <div style={{ color: 'rgba(255, 255, 255, 0.7)' }}>{config.server?.port || 'Not loaded'}</div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* File System Config */}
                                        <div style={{
                                            background: 'rgba(255, 255, 255, 0.05)',
                                            border: '1px solid rgba(255, 255, 255, 0.1)',
                                            borderRadius: '12px',
                                            padding: '16px'
                                        }}>
                                            <h4 style={{ color: 'white', marginTop: 0, marginBottom: '12px' }}>File System</h4>
                                            <div>
                                                <label style={{ color: 'white', display: 'block', marginBottom: '4px' }}>Storage Path:</label>
                                                <div style={{ color: 'rgba(255, 255, 255, 0.7)' }}>{config.fileSystem?.storagePath || 'Not loaded'}</div>
                                            </div>
                                        </div>

                                        <div style={{ textAlign: 'center', marginTop: '16px' }}>
                                            <div style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '14px' }}>
                                                Configuration editing will be available in a future update
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

// For backward compatibility
const SettingsModal = AdminPanel;

// Make AdminPanel available globally
window.AdminPanel = AdminPanel;