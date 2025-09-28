// Intelligent Refresh Control Component with JSX
const RefreshControl = ({ token, currentPath, onRefreshComplete }) => {
    const [refreshing, setRefreshing] = React.useState(false);
    const [strategy, setStrategy] = React.useState('smart');
    const [showDropdown, setShowDropdown] = React.useState(false);
    const [progress, setProgress] = React.useState(null);

    // Available strategies
    const strategies = [
        { 
            value: 'smart', 
            label: '🧠 智能刷新', 
            description: '只刷新变更的部分',
            icon: '🧠'
        },
        { 
            value: 'fast', 
            label: '⚡ 快速刷新', 
            description: '仅元数据扫描',
            icon: '⚡'
        },
        { 
            value: 'full', 
            label: '🔄 完整刷新', 
            description: '完全重新扫描',
            icon: '🔄'
        }
    ];

    const handleRefresh = async (selectedStrategy = strategy) => {
        setRefreshing(true);
        setShowDropdown(false);
        setProgress({ stage: 'starting', percent: 0, message: '准备刷新...' });

        try {
            const response = await fetch('/api/files/refresh-cache', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    strategy: selectedStrategy,
                    targetPath: currentPath
                })
            });

            if (response.ok) {
                // Monitor progress
                await monitorProgress();
                console.log(`Refresh completed with strategy: ${selectedStrategy}`);
                if (onRefreshComplete) onRefreshComplete();
            } else {
                throw new Error('刷新失败');
            }
        } catch (error) {
            console.error('Refresh error:', error);
            setProgress({ stage: 'error', percent: 0, message: `刷新失败: ${error.message}`, isError: true });
        } finally {
            setTimeout(() => {
                setRefreshing(false);
                setProgress(null);
            }, 1000);
        }
    };

    // Monitor refresh progress
    const monitorProgress = async () => {
        for (let i = 0; i < 10; i++) {
            try {
                const response = await fetch('/api/files/cache-progress', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.ok) {
                    const data = await response.json();
                    
                    if (!data.isScanning) {
                        setProgress({ stage: 'complete', percent: 100, message: '刷新完成！', isComplete: true });
                        break;
                    } else {
                        const totalItems = (data.layers.metadata?.totalItems || 0) + 
                                         (data.layers.content?.totalItems || 0);
                        const percent = Math.min(90, Math.max(10, (totalItems / 1000) * 100));
                        
                        setProgress({
                            stage: 'scanning',
                            percent: percent,
                            message: `扫描中... ${totalItems} 项目`
                        });
                    }
                }
            } catch (error) {
                console.error('Progress monitoring error:', error);
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    };

    const currentStrategy = strategies.find(s => s.value === strategy);

    return (
        <div style={{ position: 'relative', display: 'inline-block' }}>
            {/* Main refresh button */}
            <button
                onClick={() => !refreshing && setShowDropdown(!showDropdown)}
                disabled={refreshing}
                style={{
                    background: refreshing ? 
                        'rgba(255, 165, 0, 0.2)' : 
                        'rgba(34, 197, 94, 0.2)',
                    border: refreshing ? 
                        '1px solid rgba(255, 165, 0, 0.5)' : 
                        '1px solid rgba(34, 197, 94, 0.5)',
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
                    backdropFilter: 'blur(10px)',
                    transition: 'all 0.3s ease',
                    minWidth: '120px',
                    justifyContent: 'center'
                }}
                onMouseEnter={(e) => {
                    if (!refreshing) {
                        e.target.style.background = 'rgba(34, 197, 94, 0.3)';
                    }
                }}
                onMouseLeave={(e) => {
                    if (!refreshing) {
                        e.target.style.background = 'rgba(34, 197, 94, 0.2)';
                    }
                }}
            >
                {refreshing ? (
                    <>
                        <div style={{
                            width: '14px',
                            height: '14px',
                            border: '2px solid rgba(255, 255, 255, 0.3)',
                            borderTop: '2px solid white',
                            borderRadius: '50%',
                            animation: 'spin 1s linear infinite'
                        }}></div>
                        刷新中...
                    </>
                ) : (
                    <>
                        {currentStrategy?.icon || '🔄'}
                        刷新 ▼
                    </>
                )}
            </button>

            {/* Strategy dropdown */}
            {showDropdown && !refreshing && (
                <div style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: '4px',
                    background: 'rgba(0, 0, 0, 0.9)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '12px',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    boxShadow: '0 10px 25px rgba(0, 0, 0, 0.3)',
                    zIndex: 1000,
                    minWidth: '280px',
                    overflow: 'hidden'
                }}>
                    <div style={{
                        padding: '12px 16px',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                        color: 'rgba(255, 255, 255, 0.8)',
                        fontSize: '12px',
                        fontWeight: '500'
                    }}>
                        选择刷新策略
                    </div>

                    {strategies.map((strat) => (
                        <div
                            key={strat.value}
                            onClick={() => {
                                setStrategy(strat.value);
                                handleRefresh(strat.value);
                            }}
                            style={{
                                padding: '12px 16px',
                                cursor: 'pointer',
                                borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '12px',
                                transition: 'all 0.2s ease'
                            }}
                            onMouseEnter={(e) => {
                                e.target.style.background = 'rgba(255, 255, 255, 0.1)';
                            }}
                            onMouseLeave={(e) => {
                                e.target.style.background = 'transparent';
                            }}
                        >
                            <div style={{
                                fontSize: '20px',
                                width: '24px',
                                textAlign: 'center'
                            }}>
                                {strat.icon}
                            </div>
                            <div style={{ flex: 1 }}>
                                <div style={{
                                    color: 'white',
                                    fontSize: '14px',
                                    fontWeight: '500',
                                    marginBottom: '2px'
                                }}>
                                    {strat.label}
                                </div>
                                <div style={{
                                    color: 'rgba(255, 255, 255, 0.6)',
                                    fontSize: '12px'
                                }}>
                                    {strat.description}
                                </div>
                            </div>
                            {strategy === strat.value && (
                                <div style={{
                                    color: '#22c55e',
                                    fontSize: '14px'
                                }}>
                                    ✓
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Progress overlay */}
            {refreshing && progress && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0, 0, 0, 0.7)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 2000
                }}>
                    <div style={{
                        background: 'rgba(255, 255, 255, 0.1)',
                        backdropFilter: 'blur(20px)',
                        borderRadius: '20px',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        padding: '30px',
                        width: '90%',
                        maxWidth: '400px',
                        color: 'white',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            fontSize: '48px',
                            marginBottom: '16px'
                        }}>
                            {currentStrategy?.icon || '🔄'}
                        </div>

                        <h3 style={{
                            margin: '0 0 16px 0',
                            fontSize: '20px',
                            fontWeight: '600'
                        }}>
                            {currentStrategy?.label || '刷新中'}
                        </h3>

                        <div style={{
                            background: 'rgba(255, 255, 255, 0.1)',
                            borderRadius: '10px',
                            height: '8px',
                            marginBottom: '16px',
                            overflow: 'hidden'
                        }}>
                            <div style={{
                                background: progress.isError ? 
                                    'linear-gradient(90deg, #ef4444, #dc2626)' :
                                    'linear-gradient(90deg, #22c55e, #16a34a)',
                                height: '100%',
                                width: `${progress.percent}%`,
                                transition: 'width 0.3s ease',
                                borderRadius: '10px'
                            }}></div>
                        </div>

                        <p style={{
                            margin: '0 0 8px 0',
                            fontSize: '14px',
                            color: progress.isError ? '#ef4444' : 'rgba(255, 255, 255, 0.8)'
                        }}>
                            {progress.message}
                        </p>
                    </div>
                </div>
            )}

            {/* Click outside to close dropdown */}
            {showDropdown && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: 999
                    }}
                    onClick={() => setShowDropdown(false)}
                />
            )}
        </div>
    );
};

// Export for use in other components
if (typeof window !== 'undefined') {
    window.RefreshControl = RefreshControl;
}