// Simplified Refresh Control Component
const RefreshControl = ({ token, currentPath, onRefreshComplete }) => {
    const [refreshing, setRefreshing] = React.useState(false);

    const handleRefresh = async () => {
        setRefreshing(true);

        try {
            // Simple refresh - just refetch the current directory
            const response = await fetch('/api/files/refresh-cache', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    path: currentPath || '/'
                })
            });

            if (response.ok) {
                console.log('Directory refreshed successfully');
                if (onRefreshComplete) onRefreshComplete();
            } else {
                throw new Error('刷新失敗');
            }
        } catch (error) {
            console.error('Refresh error:', error);
            alert(`刷新失敗: ${error.message}`);
        } finally {
            setTimeout(() => {
                setRefreshing(false);
            }, 500);
        }
    };

    return React.createElement('button', {
        onClick: handleRefresh,
        disabled: refreshing,
        style: {
            background: refreshing 
                ? 'rgba(107, 114, 128, 0.5)' 
                : 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
            border: 'none',
            borderRadius: '8px',
            color: 'white',
            padding: '10px 16px',
            cursor: refreshing ? 'not-allowed' : 'pointer',
            fontSize: '14px',
            fontWeight: '500',
            outline: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            opacity: refreshing ? 0.7 : 1,
            transition: 'all 0.3s ease'
        }
    }, [
        React.createElement('span', { 
            key: 'icon',
            style: { 
                animation: refreshing ? 'spin 1s linear infinite' : 'none',
                display: 'inline-block'
            } 
        }, refreshing ? '⟳' : '🔄'),
        refreshing ? '刷新中...' : '刷新'
    ]);
};

// CSS animation for spinning icon
const style = document.createElement('style');
style.textContent = `
    @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }
`;
document.head.appendChild(style);

// Make RefreshControl available globally
window.RefreshControl = RefreshControl;
