// User Dropdown Component
const UserDropdown = ({ user, onSettings, onLogout, onClose }) => {
    return (
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
                    // Open admin panel in new window
                    window.open('/admin', '_blank');
                    onClose();
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
                <span>📋</span>
                <span>Admin Panel</span>
            </button>
            <button
                onClick={onSettings}
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
                    onClose();
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
                    onClick={onLogout}
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
    );
};
