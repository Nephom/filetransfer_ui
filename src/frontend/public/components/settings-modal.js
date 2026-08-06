// Settings Modal Component
const SettingsModal = ({ onClose, token }) => {
    const [settings, setSettings] = useState({});
    const [users, setUsers] = useState([]);
    const [userStats, setUserStats] = useState(null);
    const [config, setConfig] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [activeTab, setActiveTab] = useState('security');
    const [userRole, setUserRole] = useState(null);

    // Check user role on mount
    useEffect(() => {
        const checkUserRole = async () => {
            try {
                // Attempt to fetch user info to determine role
                const response = await fetch('/api/admin/users', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (response.ok) {
                    setUserRole('admin');
                } else if (response.status === 403) {
                    setUserRole('user');
                }
            } catch (err) {
                // If we can't determine the role, default to user
                setUserRole('user');
            }
        };
        
        checkUserRole();
    }, [token]);
    const [showCreateUser, setShowCreateUser] = useState(false);
    const [editingUser, setEditingUser] = useState(null);
    const [configSection, setConfigSection] = useState('server');

    useEffect(() => {
        const loadInitialData = async () => {
            setLoading(true);
            await fetchSettings();
            setLoading(false);
        };
        loadInitialData();
    }, []);

    useEffect(() => {
        // Reset messages when tab changes
        setError('');
        setSuccess('');

        if (activeTab === 'users' && users.length === 0) {
            fetchUsers();
        }
        if (activeTab === 'config' && Object.keys(config).length === 0) {
            fetchConfig();
        }
    }, [activeTab]);

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
                setUserStats(data.stats || null);
            } else {
                throw new Error('Failed to load users');
            }
        } catch (err) {
            console.warn('Failed to load users:', err);
            setError('Could not load users. You may not have permission.');
        }
    };

    const createUser = async (userData) => {
        try {
            setSaving(true);
            setError('');
            const response = await fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(userData)
            });
            const data = await response.json();
            if (response.ok) {
                setSuccess(data.message);
                setShowCreateUser(false);
                await fetchUsers();
            } else {
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
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(updates)
            });
            const data = await response.json();
            if (response.ok) {
                setSuccess(data.message);
                setEditingUser(null);
                await fetchUsers();
            } else {
                setError(data.error || 'Failed to update user');
            }
        } catch (err) {
            setError('Failed to update user');
        } finally {
            setSaving(false);
        }
    };

    const deleteUser = async (username) => {
        if (!window.confirm(`Are you sure you want to delete user "${username}"?`)) return;
        try {
            setSaving(true);
            setError('');
            const response = await fetch(`/api/admin/users/${username}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await response.json();
            if (response.ok) {
                setSuccess(data.message);
                await fetchUsers();
            } else {
                setError(data.error || 'Failed to delete user');
            }
        } catch (err) {
            setError('Failed to delete user');
        } finally {
            setSaving(false);
        }
    };

    const saveConfig = async () => {
        try {
            setSaving(true);
            setError('');
            setSuccess('');
            const payload = { ...config, security: { ...(config.security || {}) } };
            if (payload.security.jwtSecret === '[SET]' || payload.security.jwtSecret === '[DEFAULT]') delete payload.security.jwtSecret;
            validateLocations(payload.locations || []);
            const response = await fetch('/api/admin/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (response.ok) {
                let successMsg = data.message;
                if (data.needsRestart) {
                    successMsg += ' Server restart may be required for some changes to take effect.';
                }
                setSuccess(successMsg);
                if (payload.locations) window.dispatchEvent(new CustomEvent('locations-updated'));
                await fetchConfig();
            } else {
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
                const loadedConfig = data.config || data;
                setConfig(loadedConfig);
            } else {
                throw new Error('Failed to load config');
            }
        } catch (err) {
            console.warn('Failed to load config:', err);
            setError('Could not load config. You may not have permission.');
        }
    };

    const saveSettings = async () => {
        setSaving(true);
        setError('');
        setSuccess('');
        try {
            const response = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
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
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const handleConfigChange = (section, key, value) => {
        setConfig(prev => ({
            ...prev,
            [section]: {
                ...prev[section],
                [key]: value
            }
        }));
    };

    const updateLocation = (index, key, value) => {
        setConfig(prev => ({
            ...prev,
            locations: (Array.isArray(prev.locations) ? prev.locations : []).map((location, locationIndex) =>
                locationIndex === index ? { ...location, [key]: value } : location
            )
        }));
    };

    const addLocation = () => {
        setConfig(prev => ({
            ...prev,
            locations: [
                ...(Array.isArray(prev.locations) ? prev.locations : []),
                {
                    id: '',
                    displayName: '',
                    rootPath: '',
                    enabled: true,
                    readOnly: false,
                    order: Array.isArray(prev.locations) ? prev.locations.length : 0
                }
            ]
        }));
    };

    const removeLocation = (index) => {
        if (!window.confirm('Remove this Location? Existing user permissions may refer to its ID.')) return;
        setConfig(prev => ({
            ...prev,
            locations: (Array.isArray(prev.locations) ? prev.locations : []).filter((_, locationIndex) => locationIndex !== index)
        }));
    };

    const validateLocations = (locations) => {
        if (!Array.isArray(locations) || locations.length === 0) throw new Error('Add at least one Server Location.');
        const ids = new Set();
        locations.forEach((location, index) => {
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(location.id || ''))) {
                throw new Error(`Location ${index + 1}: ID must start with a letter or number and contain only letters, numbers, _ or -.`);
            }
            if (ids.has(location.id)) throw new Error(`Duplicate Location ID: ${location.id}`);
            ids.add(location.id);
            if (!String(location.displayName || '').trim()) throw new Error(`Location ${location.id}: display name is required.`);
            if (!String(location.rootPath || '').trim()) throw new Error(`Location ${location.id}: root path is required.`);
            if (!Number.isInteger(Number(location.order)) || Number(location.order) < 0) throw new Error(`Location ${location.id}: order must be a non-negative integer.`);
        });
    };

    const securityFeatures = [
        { key: 'enableRateLimit', name: 'Rate Limiting', description: 'Limit request frequency to prevent abuse' },
        { key: 'enableSecurityHeaders', name: 'Security Headers', description: 'Add security headers like HSTS, CSP, etc.' },
        { key: 'enableInputValidation', name: 'Input Validation', description: 'Validate and sanitize user inputs' },
        { key: 'enableFileUploadSecurity', name: 'File Upload Security', description: 'Check file types and sizes for uploads' },
        { key: 'enableRequestLogging', name: 'Request Logging', description: 'Log all requests for monitoring' },
        { key: 'enableCSP', name: 'Content Security Policy', description: 'Strict CSP headers for XSS protection' }
    ];

    const TabButton = ({ label, tabName }) => (
        <button
            onClick={() => setActiveTab(tabName)}
            style={{
                background: activeTab === tabName ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
                border: 'none',
                borderBottom: activeTab === tabName ? '2px solid #3b82f6' : '2px solid transparent',
                color: 'white',
                padding: '12px 20px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500',
                transition: 'all 0.3s ease',
                outline: 'none'
            }}
        >
            {label}
        </button>
    );

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
            backdropFilter: 'blur(5px)', padding: '20px'
        }}>
            <div style={{
                background: 'rgba(255, 255, 255, 0.1)', backdropFilter: 'blur(20px)', borderRadius: '20px',
                border: '1px solid rgba(255, 255, 255, 0.2)', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                width: '100%', maxWidth: '800px', maxHeight: '90vh', overflow: 'hidden',
                display: 'flex', flexDirection: 'column'
            }}>
                <div style={{
                    padding: '24px', borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                }}>
                    <div>
                        <h2 style={{ color: 'white', margin: 0, fontSize: '24px', fontWeight: 'bold' }}>Settings</h2>
                        <p style={{ color: 'rgba(255, 255, 255, 0.8)', margin: 0, fontSize: '14px', marginTop: '4px' }}>
                            Manage your file transfer system
                        </p>
                    </div>
                    <button onClick={onClose} style={{
                        background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '8px', color: 'white', width: '32px', height: '32px', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px',
                        outline: 'none', transition: 'all 0.3s ease'
                    }}
                    onMouseEnter={(e) => { e.target.style.background = 'rgba(255, 255, 255, 0.2)'; }}
                    onMouseLeave={(e) => { e.target.style.background = 'rgba(255, 255, 255, 0.1)'; }}>
                        ✕
                    </button>
                </div>

                <div style={{ display: 'flex', padding: '0 24px', borderBottom: '1px solid rgba(255, 255, 255, 0.2)' }}>
                    <TabButton label="Security" tabName="security" />
                    {userRole === 'admin' && <TabButton label="User Management" tabName="users" />}
                    {userRole === 'admin' && <TabButton label="Configuration" tabName="config" />}
                </div>

                <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
                    {loading ? (
                        <div style={{ textAlign: 'center', padding: '40px' }}>
                            <div style={{
                                width: '40px', height: '40px', border: '3px solid rgba(255, 255, 255, 0.3)',
                                borderTop: '3px solid white', borderRadius: '50%', animation: 'spin 1s linear infinite',
                                margin: '0 auto 16px'
                            }}></div>
                            <p style={{ color: 'white', margin: 0 }}>Loading...</p>
                        </div>
                    ) : (
                        <div>
                            {error && (
                                <div style={{
                                    background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.5)',
                                    borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', display: 'flex',
                                    alignItems: 'center', gap: '8px', backdropFilter: 'blur(10px)'
                                }}>
                                    <span>❌</span>
                                    <span style={{ color: 'white', fontSize: '14px' }}>{error}</span>
                                </div>
                            )}
                            {success && (
                                <div style={{
                                    background: 'rgba(34, 197, 94, 0.2)', border: '1px solid rgba(34, 197, 94, 0.5)',
                                    borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', display: 'flex',
                                    alignItems: 'center', gap: '8px', backdropFilter: 'blur(10px)'
                                }}>
                                    <span>✅</span>
                                    <span style={{ color: 'white', fontSize: '14px' }}>{success}</span>
                                </div>
                            )}

                            {activeTab === 'security' && (
                                <div>
                                    <div style={{ marginBottom: '32px' }}>
                                        <h3 style={{ color: 'white', fontSize: '18px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span>🛡️</span> Always Enabled (Core Security)
                                        </h3>
                                        <div style={{
                                            background: 'rgba(34, 197, 94, 0.2)', border: '1px solid rgba(34, 197, 94, 0.3)',
                                            borderRadius: '12px', padding: '16px', backdropFilter: 'blur(10px)'
                                        }}>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><span style={{ color: '#22c55e' }}>✅</span><span style={{ color: 'white', fontSize: '14px' }}>JWT Token Authentication</span></div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><span style={{ color: '#22c55e' }}>✅</span><span style={{ color: 'white', fontSize: '14px' }}>Password Hashing (bcrypt)</span></div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><span style={{ color: '#22c55e' }}>✅</span><span style={{ color: 'white', fontSize: '14px' }}>HTTPS Data Transmission (when configured)</span></div>
                                            </div>
                                        </div>
                                    </div>
                                    <div style={{ marginBottom: '24px' }}>
                                        <h3 style={{ color: 'white', fontSize: '18px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span>⚙️</span> Configurable Security Features
                                        </h3>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                            {securityFeatures.map(feature => (
                                                <SecurityFeatureToggle key={feature.key} feature={feature} enabled={settings[feature.key] === true} onChange={(value) => handleSettingChange(feature.key, value)} />
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'users' && userRole === 'admin' && (
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                        <h3 style={{ color: 'white', marginTop: 0, marginBottom: 0 }}>User Management</h3>
                                        <button onClick={() => setShowCreateUser(true)} style={{
                                            background: 'linear-gradient(135deg, #34d399, #10b981)', border: 'none', borderRadius: '8px',
                                            color: 'white', padding: '8px 16px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold', outline: 'none'
                                        }}>+ Create User</button>
                                    </div>
                                    {userStats && (
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', marginBottom: '20px' }}>
                                            <div style={{ background: 'rgba(59, 130, 246, 0.2)', padding: '12px', borderRadius: '8px', textAlign: 'center' }}><div style={{ color: '#60a5fa', fontSize: '24px', fontWeight: 'bold' }}>{userStats.total}</div><div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '12px' }}>Total Users</div></div>
                                            <div style={{ background: 'rgba(34, 197, 94, 0.2)', padding: '12px', borderRadius: '8px', textAlign: 'center' }}><div style={{ color: '#4ade80', fontSize: '24px', fontWeight: 'bold' }}>{userStats.active}</div><div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '12px' }}>Active</div></div>
                                            <div style={{ background: 'rgba(239, 68, 68, 0.2)', padding: '12px', borderRadius: '8px', textAlign: 'center' }}><div style={{ color: '#f87171', fontSize: '24px', fontWeight: 'bold' }}>{userStats.admins}</div><div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '12px' }}>Admins</div></div>
                                            <div style={{ background: 'rgba(168, 85, 247, 0.2)', padding: '12px', borderRadius: '8px', textAlign: 'center' }}><div style={{ color: '#a78bfa', fontSize: '24px', fontWeight: 'bold' }}>{userStats.recentLogins}</div><div style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '12px' }}>Recent Logins</div></div>
                                        </div>
                                    )}
                                    <div style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '12px', overflow: 'hidden' }}>
                                        {users.length > 0 ? (
                                            <div>{users.map(user => (
                                                <div key={user.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px', borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}>
                                                    <div style={{ flex: 1 }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                                            <span style={{ color: 'white', fontWeight: 'bold' }}>{user.username}</span>
                                                            <span style={{ padding: '2px 8px', borderRadius: '12px', fontSize: '10px', background: user.role === 'admin' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(34, 197, 94, 0.3)', color: user.role === 'admin' ? '#fca5a5' : '#86efac' }}>{user.role}</span>
                                                            {!user.active && (<span style={{ padding: '2px 8px', borderRadius: '12px', fontSize: '10px', background: 'rgba(107, 114, 128, 0.3)', color: '#9ca3af' }}>INACTIVE</span>)}
                                                        </div>
                                                        <div style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '12px' }}>
                                                            {user.email} | Created: {new Date(user.created).toLocaleDateString()}
                                                            {user.lastLogin && ` | Last login: ${new Date(user.lastLogin).toLocaleDateString()}`}
                                                        </div>
                                                    </div>
                                                     <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                                         {user.isConfigUser ? (
                                                             <span style={{ color: 'rgba(255, 255, 255, 0.65)', fontSize: '11px' }}>Managed in Configuration</span>
                                                         ) : (
                                                             <>
                                                                 <button onClick={() => setEditingUser(user)} style={{ background: 'rgba(59, 130, 246, 0.2)', border: '1px solid rgba(59, 130, 246, 0.5)', borderRadius: '6px', color: '#60a5fa', padding: '4px 8px', cursor: 'pointer', fontSize: '12px' }}>Edit</button>
                                                                 <button onClick={() => deleteUser(user.username)} style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.5)', borderRadius: '6px', color: '#f87171', padding: '4px 8px', cursor: 'pointer', fontSize: '12px' }}>Delete</button>
                                                             </>
                                                         )}
                                                     </div>
                                                </div>
                                            ))}</div>
                                        ) : (<div style={{ color: 'rgba(255, 255, 255, 0.7)', textAlign: 'center', padding: '40px' }}>No users found.</div>)}
                                    </div>
                                </div>
                            )}

                            {activeTab === 'config' && userRole === 'admin' && (
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                        <h3 style={{ color: 'white', marginTop: 0, marginBottom: 0 }}>Configuration</h3>
                                        <div style={{ display: 'flex', gap: '8px' }}>
                                            <button onClick={() => window.open('/api/admin/config/backup', '_blank')} style={{ background: 'rgba(168, 85, 247, 0.2)', border: '1px solid rgba(168, 85, 247, 0.5)', borderRadius: '6px', color: '#a78bfa', padding: '6px 12px', cursor: 'pointer', fontSize: '12px' }}>📥 Backup</button>
                                            <select value={configSection} onChange={(e) => setConfigSection(e.target.value)} style={{ background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '6px 12px', fontSize: '12px' }}>
                                                {Object.keys(config).map(section => <option key={section} value={section}>{section.charAt(0).toUpperCase() + section.slice(1)}</option>)}
                                            </select>
                                        </div>
                                    </div>
                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        {configSection === 'locations' ? (
                                            <div style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '12px', padding: '16px' }}>
                                                <label style={{ color: 'white', display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>Server Locations</label>
                                                <p style={{ color: 'rgba(255, 255, 255, 0.75)', fontSize: '12px', lineHeight: 1.5 }}>Use server paths such as <code>/mnt/nfs/team-a</code>, not paths from the user's computer. For NFS, mount the share on the server first. Location IDs must stay stable after permissions are assigned. Changes apply immediately.</p>
                                                <div style={{ overflowX: 'auto' }}>
                                                    <table style={{ width: '100%', minWidth: '860px', borderCollapse: 'collapse', color: 'white', fontSize: '12px' }}>
                                                        <thead><tr style={{ color: 'rgba(255, 255, 255, 0.75)', textAlign: 'left' }}>
                                                            <th style={{ padding: '8px' }}>ID</th><th style={{ padding: '8px' }}>Display name</th><th style={{ padding: '8px' }}>Root path</th><th style={{ padding: '8px' }}>Storage type</th><th style={{ padding: '8px' }}>Enabled</th><th style={{ padding: '8px' }}>Read-only</th><th style={{ padding: '8px' }}>Order</th><th style={{ padding: '8px' }}>Actions</th>
                                                        </tr></thead>
                                                        <tbody>
                                                            {(Array.isArray(config.locations) ? config.locations : []).map((location, index) => (
                                                                <tr key={`${location.id || 'new'}-${index}`} style={{ borderTop: '1px solid rgba(255, 255, 255, 0.12)' }}>
                                                                     {['id', 'displayName', 'rootPath'].map(field => <td key={field} style={{ padding: '8px' }}><input value={location[field] || ''} onChange={(e) => updateLocation(index, field, e.target.value)} placeholder={field === 'id' ? 'team-a' : field === 'displayName' ? 'Team A' : '/mnt/nfs/team-a'} style={{ width: field === 'rootPath' ? '220px' : '120px', boxSizing: 'border-box', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px' }} /></td>)}
                                                                     <td style={{ padding: '8px' }}><select value={location.storageType || 'local'} onChange={(e) => updateLocation(index, 'storageType', e.target.value)} style={{ width: '90px', boxSizing: 'border-box', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px' }}><option value="local">Local</option><option value="nfs">NFS</option></select></td>
                                                                    <td style={{ padding: '8px', textAlign: 'center' }}><input type="checkbox" checked={location.enabled !== false} onChange={(e) => updateLocation(index, 'enabled', e.target.checked)} aria-label={`Enable ${location.displayName || 'Location'}`} /></td>
                                                                    <td style={{ padding: '8px', textAlign: 'center' }}><input type="checkbox" checked={location.readOnly === true} onChange={(e) => updateLocation(index, 'readOnly', e.target.checked)} aria-label={`Read-only ${location.displayName || 'Location'}`} /></td>
                                                                    <td style={{ padding: '8px' }}><input type="number" min="0" step="1" value={location.order ?? index} onChange={(e) => updateLocation(index, 'order', e.target.value === '' ? '' : Number(e.target.value))} style={{ width: '64px', boxSizing: 'border-box', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px' }} aria-label="Display order" /></td>
                                                                    <td style={{ padding: '8px' }}><button type="button" onClick={() => removeLocation(index)} style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.5)', borderRadius: '6px', color: '#f87171', padding: '7px 9px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Remove</button></td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                                <button type="button" onClick={addLocation} style={{ marginTop: '12px', background: 'rgba(59, 130, 246, 0.2)', border: '1px solid rgba(59, 130, 246, 0.5)', borderRadius: '6px', color: '#93c5fd', padding: '8px 12px', cursor: 'pointer' }}>+ Add Location</button>
                                            </div>
                                        ) : config[configSection] ? Object.entries(config[configSection]).map(([key, value]) => (
                                            <div key={key} style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '12px', padding: '16px' }}>
                                                <label style={{ color: 'white', display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>{key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}</label>
                                                {typeof value === 'boolean' ? (
                                                    <label style={{ position: 'relative', display: 'inline-block', width: '48px', height: '24px', cursor: 'pointer' }}>
                                                        <input type="checkbox" checked={value} onChange={(e) => handleConfigChange(configSection, key, e.target.checked)} style={{ display: 'none' }} />
                                                        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: value ? 'linear-gradient(135deg, #3b82f6, #8b5cf6)' : 'rgba(255, 255, 255, 0.2)', borderRadius: '12px', transition: 'all 0.3s ease', border: '1px solid rgba(255, 255, 255, 0.3)' }}>
                                                            <div style={{ position: 'absolute', top: '2px', left: value ? '26px' : '2px', width: '18px', height: '18px', background: 'white', borderRadius: '50%', transition: 'all 0.3s ease', boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)' }}></div>
                                                        </div>
                                                    </label>
                                                ) : (
                                                    <input type={configSection === 'auth' && key === 'password' ? 'password' : typeof value === 'number' ? 'number' : 'text'} value={configSection === 'auth' && key === 'password' && value === '[SET]' ? '' : value} placeholder={configSection === 'auth' && key === 'password' && value === '[SET]' ? 'Configured; enter a new password to replace it' : ''} onChange={(e) => handleConfigChange(configSection, key, typeof value === 'number' ? parseInt(e.target.value) : e.target.value)} style={{ width: '100%', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px 12px' }} />
                                                )}
                                            </div>
                                        )) : <div style={{ color: 'rgba(255, 255, 255, 0.7)', textAlign: 'center', padding: '40px' }}>No configuration for this section.</div>}
                                    </div>
                                </div>
                            )}

                            {activeTab === 'users' && userRole !== 'admin' && (
                                <div style={{ textAlign: 'center', padding: '40px' }}>
                                    <div style={{ fontSize: '48px', marginBottom: '16px' }}>🚫</div>
                                    <h3 style={{ color: 'white', margin: '0 0 16px 0' }}>Access Denied</h3>
                                    <p style={{ color: 'rgba(255, 255, 255, 0.8)', margin: 0 }}>
                                        You don't have permission to access user management.
                                    </p>
                                </div>
                            )}

                            {activeTab === 'config' && userRole !== 'admin' && (
                                <div style={{ textAlign: 'center', padding: '40px' }}>
                                    <div style={{ fontSize: '48px', marginBottom: '16px' }}>🚫</div>
                                    <h3 style={{ color: 'white', margin: '0 0 16px 0' }}>Access Denied</h3>
                                    <p style={{ color: 'rgba(255, 255, 255, 0.8)', margin: 0 }}>
                                        You don't have permission to access configuration settings.
                                    </p>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div style={{
                    padding: '24px', borderTop: '1px solid rgba(255, 255, 255, 0.2)',
                    display: 'flex', justifyContent: 'flex-end', gap: '12px'
                }}>
                    <button onClick={onClose} style={{
                        padding: '12px 24px', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '8px', color: 'white', cursor: 'pointer', fontSize: '14px', fontWeight: '500',
                        backdropFilter: 'blur(10px)', outline: 'none', transition: 'all 0.3s ease'
                    }}
                    onMouseEnter={(e) => { e.target.style.background = 'rgba(255, 255, 255, 0.2)'; }}
                    onMouseLeave={(e) => { e.target.style.background = 'rgba(255, 255, 255, 0.1)'; }}>
                        Cancel
                    </button>
                    {activeTab === 'security' && (
                        <button onClick={saveSettings} disabled={saving || loading} style={{
                            padding: '12px 24px', background: saving ? 'rgba(255, 255, 255, 0.2)' : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                            border: 'none', borderRadius: '8px', color: 'white', cursor: saving ? 'not-allowed' : 'pointer',
                            fontSize: '14px', fontWeight: '600', outline: 'none', display: 'flex', alignItems: 'center', gap: '8px', transition: 'all 0.3s ease'
                        }}>
                            {saving && (<div style={{ width: '16px', height: '16px', border: '2px solid rgba(255, 255, 255, 0.3)', borderTop: '2px solid white', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>)}
                            {saving ? 'Saving...' : 'Save Settings'}
                        </button>
                    )}
                    {activeTab === 'config' && (
                        <button onClick={saveConfig} disabled={saving || loading} style={{
                            padding: '12px 24px', background: saving ? 'rgba(255, 255, 255, 0.2)' : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                            border: 'none', borderRadius: '8px', color: 'white', cursor: saving ? 'not-allowed' : 'pointer',
                            fontSize: '14px', fontWeight: '600', outline: 'none', display: 'flex', alignItems: 'center', gap: '8px', transition: 'all 0.3s ease'
                        }}>
                            {saving && (<div style={{ width: '16px', height: '16px', border: '2px solid rgba(255, 255, 255, 0.3)', borderTop: '2px solid white', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>)}
                            {saving ? 'Saving...' : 'Save Configuration'}
                        </button>
                    )}
                </div>
            </div>

            {showCreateUser && (<CreateUserModal onClose={() => setShowCreateUser(false)} onSubmit={createUser} loading={saving} />)}
            {editingUser && (<EditUserModal user={editingUser} onClose={() => setEditingUser(null)} onSubmit={updateUser} loading={saving} />)}
        </div>
    );
};

// Create User Modal Component
const CreateUserModal = ({ onClose, onSubmit, loading }) => {
    const [formData, setFormData] = useState({ username: '', password: '', email: '', role: 'user', permissions: [] });
    const handleSubmit = (e) => { e.preventDefault(); onSubmit(formData); };
    return (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0, 0, 0, 0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
            <div style={{ background: 'rgba(255, 255, 255, 0.1)', backdropFilter: 'blur(20px)', borderRadius: '16px', border: '1px solid rgba(255, 255, 255, 0.2)', padding: '24px', width: '400px', maxWidth: '90vw' }}>
                <h3 style={{ color: 'white', marginTop: 0, marginBottom: '20px' }}>Create New User</h3>
                <form onSubmit={handleSubmit}>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Username:</label>
                        <input type="text" required value={formData.username} onChange={(e) => setFormData(prev => ({ ...prev, username: e.target.value }))} style={{ width: '100%', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px 12px' }} />
                    </div>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Password:</label>
                        <input type="password" required value={formData.password} onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))} style={{ width: '100%', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px 12px' }} />
                    </div>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Email:</label>
                        <input type="email" value={formData.email} onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))} style={{ width: '100%', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px 12px' }} />
                    </div>
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Role:</label>
                        <select value={formData.role} onChange={(e) => setFormData(prev => ({ ...prev, role: e.target.value }))} style={{ width: '100%', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px 12px' }}>
                            <option value="user">User</option>
                        </select>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                        <button type="button" onClick={onClose} style={{ background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px 16px', cursor: 'pointer' }}>Cancel</button>
                        <button type="submit" disabled={loading} style={{ background: 'linear-gradient(135deg, #34d399, #10b981)', border: 'none', borderRadius: '6px', color: 'white', padding: '8px 16px', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}>{loading ? 'Creating...' : 'Create User'}</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

// Edit User Modal Component
const EditUserModal = ({ user, onClose, onSubmit, loading }) => {
    const [formData, setFormData] = useState({ role: 'user', active: user.active, email: user.email || '', permissions: user.permissions || ['read', 'upload', 'delete'], newPassword: '' });
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
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0, 0, 0, 0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
            <div style={{ background: 'rgba(255, 255, 255, 0.1)', backdropFilter: 'blur(20px)', borderRadius: '16px', border: '1px solid rgba(255, 255, 255, 0.2)', padding: '24px', width: '400px', maxWidth: '90vw' }}>
                <h3 style={{ color: 'white', marginTop: 0, marginBottom: '20px' }}>Edit User: {user.username}</h3>
                <form onSubmit={handleSubmit}>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Email:</label>
                        <input type="email" value={formData.email} onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))} style={{ width: '100%', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px 12px' }} />
                    </div>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>Role:</label>
                        <div style={{ color: 'rgba(255, 255, 255, 0.8)', padding: '8px 12px', background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.15)', borderRadius: '6px' }}>User (the single system administrator is managed in Configuration)</div>
                    </div>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '8px', fontSize: '14px' }}>Permissions:</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                            {['read', 'upload', 'delete'].map(permission => (
                                <label key={permission} style={{ color: 'rgba(255, 255, 255, 0.85)', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                                    <input type="checkbox" checked={formData.permissions.includes(permission)} onChange={(e) => setFormData(prev => ({ ...prev, permissions: e.target.checked ? [...prev.permissions, permission] : prev.permissions.filter(item => item !== permission) }))} />
                                    {permission}
                                </label>
                            ))}
                        </div>
                    </div>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ color: 'white', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input type="checkbox" checked={formData.active} onChange={(e) => setFormData(prev => ({ ...prev, active: e.target.checked }))} disabled={user.username === 'admin'} style={{ opacity: user.username === 'admin' ? 0.5 : 1 }} />
                            Active User
                        </label>
                    </div>
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ color: 'white', display: 'block', marginBottom: '4px', fontSize: '14px' }}>New Password (leave blank to keep current):</label>
                        <input type="password" value={formData.newPassword} onChange={(e) => setFormData(prev => ({ ...prev, newPassword: e.target.value }))} style={{ width: '100%', background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px 12px' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                        <button type="button" onClick={onClose} style={{ background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: '6px', color: 'white', padding: '8px 16px', cursor: 'pointer' }}>Cancel</button>
                        <button type="submit" disabled={loading} style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', border: 'none', borderRadius: '6px', color: 'white', padding: '8px 16px', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}>{loading ? 'Updating...' : 'Update User'}</button>
                    </div>
                </form>
            </div>
        </div>
    );
};
