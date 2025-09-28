// Search Progress Display Component with JSX
const SearchProgress = ({ token, searchQuery, onSearchResults, onSearchCancel }) => {
    const [isSearching, setIsSearching] = React.useState(false);
    const [progress, setProgress] = React.useState(null);
    const [results, setResults] = React.useState([]);
    const [searchId, setSearchId] = React.useState(null);
    const [eventSource, setEventSource] = React.useState(null);
    const [totalResults, setTotalResults] = React.useState(0);

    // Start progressive search
    const startProgressiveSearch = React.useCallback(async (query) => {
        if (!query.trim() || isSearching) return;

        setIsSearching(true);
        setProgress({ phase: 'starting', percent: 0, message: '开始搜索...', scannedDirs: 0 });
        setResults([]);
        setTotalResults(0);

        try {
            // Create EventSource for progressive search
            const searchUrl = `/api/files/search/progressive?query=${encodeURIComponent(query)}&limit=1000`;
            const es = new EventSource(searchUrl);
            setEventSource(es);

            let currentSearchId = null;
            let accumulatedResults = [];
            let lastProgressUpdate = Date.now();

            es.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);

                    if (data.type === 'progress') {
                        currentSearchId = data.searchId;
                        setSearchId(currentSearchId);

                        // Update progress
                        const progressPercent = Math.min(95, (data.results.length / 100) * 100);
                        setProgress({
                            phase: data.phase || 'searching',
                            percent: progressPercent,
                            message: `搜索中... 找到 ${data.results.length} 个结果`,
                            scannedDirs: Math.floor(data.results.length / 10) + 1,
                            phase_description: getPhaseDescription(data.phase)
                        });

                        // Accumulate results
                        accumulatedResults = [...accumulatedResults, ...data.results];
                        
                        // Throttled updates to avoid overwhelming UI
                        const now = Date.now();
                        if (now - lastProgressUpdate > 300) { // Update every 300ms
                            setResults([...accumulatedResults]);
                            setTotalResults(accumulatedResults.length);
                            lastProgressUpdate = now;
                            
                            // Pass results to parent
                            if (onSearchResults) {
                                onSearchResults(accumulatedResults);
                            }
                        }

                        // Check if complete
                        if (data.isComplete) {
                            setProgress({
                                phase: 'complete',
                                percent: 100,
                                message: `搜索完成！找到 ${accumulatedResults.length} 个结果`,
                                scannedDirs: Math.floor(accumulatedResults.length / 10) + 1,
                                isComplete: true
                            });

                            // Final results update
                            setResults([...accumulatedResults]);
                            setTotalResults(accumulatedResults.length);
                            
                            if (onSearchResults) {
                                onSearchResults(accumulatedResults);
                            }

                            setTimeout(() => {
                                setIsSearching(false);
                                setProgress(null);
                            }, 2000);
                        }
                    } else if (data.type === 'complete') {
                        es.close();
                        setEventSource(null);
                    }
                } catch (error) {
                    console.error('Search progress parsing error:', error);
                }
            };

            es.onerror = (error) => {
                console.error('Search EventSource error:', error);
                setProgress({
                    phase: 'error',
                    percent: 0,
                    message: '搜索连接中断',
                    isError: true
                });
                es.close();
                setEventSource(null);
                setIsSearching(false);
            };

        } catch (error) {
            console.error('Search error:', error);
            setProgress({
                phase: 'error',
                percent: 0,
                message: `搜索失败: ${error.message}`,
                isError: true
            });
            setIsSearching(false);
        }
    }, [isSearching, onSearchResults]);

    // Cancel search
    const cancelSearch = React.useCallback(() => {
        if (eventSource) {
            eventSource.close();
            setEventSource(null);
        }
        setIsSearching(false);
        setProgress(null);
        setResults([]);
        setTotalResults(0);
        setSearchId(null);

        if (onSearchCancel) {
            onSearchCancel();
        }
    }, [eventSource, onSearchCancel]);

    // Get phase description
    const getPhaseDescription = (phase) => {
        switch (phase) {
            case 'initialization':
                return '初始化搜索引擎';
            case 'metadata_scan':
                return '扫描元数据层';
            case 'content_scan':
                return '扫描内容层';
            case 'directory_scan':
                return '扫描目录结构';
            case 'indexing':
                return '建立索引';
            case 'filtering':
                return '过滤结果';
            case 'ranking':
                return '结果排序';
            case 'complete':
                return '搜索完成';
            default:
                return '处理中...';
        }
    };

    // Start search when query changes
    React.useEffect(() => {
        if (searchQuery && searchQuery.trim().length > 0) {
            startProgressiveSearch(searchQuery);
        } else {
            cancelSearch();
        }

        // Cleanup on unmount
        return () => {
            if (eventSource) {
                eventSource.close();
            }
        };
    }, [searchQuery, startProgressiveSearch, cancelSearch]);

    // Don't render if no search in progress
    if (!isSearching && !progress) {
        return null;
    }

    return (
        <div style={{
            background: 'rgba(59, 130, 246, 0.1)',
            backdropFilter: 'blur(10px)',
            borderRadius: '12px',
            border: '1px solid rgba(59, 130, 246, 0.2)',
            padding: '16px',
            margin: '8px 24px',
            color: 'white'
        }}>
            {/* Search header */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '12px'
            }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                }}>
                    <div style={{
                        fontSize: '20px'
                    }}>
                        🔍
                    </div>
                    <span style={{
                        fontSize: '14px',
                        fontWeight: '500'
                    }}>
                        搜索进度
                    </span>
                    {searchId && (
                        <span style={{
                            fontSize: '10px',
                            color: 'rgba(255, 255, 255, 0.6)',
                            fontFamily: 'monospace'
                        }}>
                            ID: {searchId.substring(0, 8)}...
                        </span>
                    )}
                </div>

                {isSearching && (
                    <button
                        onClick={cancelSearch}
                        style={{
                            background: 'rgba(239, 68, 68, 0.2)',
                            border: '1px solid rgba(239, 68, 68, 0.5)',
                            borderRadius: '6px',
                            color: 'white',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            outline: 'none'
                        }}
                    >
                        取消
                    </button>
                )}
            </div>

            {/* Progress bar */}
            {progress && (
                <div style={{
                    marginBottom: '12px'
                }}>
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '6px'
                    }}>
                        <span style={{
                            fontSize: '12px',
                            color: progress.isError ? '#ef4444' : 'rgba(255, 255, 255, 0.8)'
                        }}>
                            {progress.message}
                        </span>
                        <span style={{
                            fontSize: '12px',
                            color: 'rgba(255, 255, 255, 0.6)'
                        }}>
                            {Math.round(progress.percent)}%
                        </span>
                    </div>

                    <div style={{
                        background: 'rgba(255, 255, 255, 0.1)',
                        borderRadius: '4px',
                        height: '6px',
                        overflow: 'hidden'
                    }}>
                        <div style={{
                            background: progress.isError ?
                                'linear-gradient(90deg, #ef4444, #dc2626)' :
                                progress.isComplete ?
                                    'linear-gradient(90deg, #22c55e, #16a34a)' :
                                    'linear-gradient(90deg, #3b82f6, #1d4ed8)',
                            height: '100%',
                            width: `${progress.percent}%`,
                            transition: 'width 0.3s ease',
                            borderRadius: '4px'
                        }}></div>
                    </div>
                </div>
            )}

            {/* Progress details */}
            {progress && (
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '12px',
                    fontSize: '12px',
                    color: 'rgba(255, 255, 255, 0.7)'
                }}>
                    <div>
                        <strong style={{ color: 'white' }}>阶段:</strong> {progress.phase_description || '处理中...'}
                    </div>
                    <div>
                        <strong style={{ color: 'white' }}>已扫描:</strong> {progress.scannedDirs || 0} 个目录
                    </div>
                    <div>
                        <strong style={{ color: 'white' }}>找到结果:</strong> {totalResults} 个文件
                    </div>
                    <div>
                        <strong style={{ color: 'white' }}>状态:</strong> {
                            progress.isComplete ? '✅ 完成' : 
                            progress.isError ? '❌ 错误' : 
                            '⏳ 搜索中'
                        }
                    </div>
                </div>
            )}

            {/* Real-time results preview */}
            {results.length > 0 && (
                <div style={{
                    marginTop: '12px',
                    paddingTop: '12px',
                    borderTop: '1px solid rgba(255, 255, 255, 0.1)'
                }}>
                    <div style={{
                        fontSize: '12px',
                        color: 'rgba(255, 255, 255, 0.8)',
                        marginBottom: '8px'
                    }}>
                        实时结果预览 (显示前5个):
                    </div>
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                        maxHeight: '120px',
                        overflowY: 'auto'
                    }}>
                        {results.slice(0, 5).map((result, index) => (
                            <div
                                key={index}
                                style={{
                                    background: 'rgba(255, 255, 255, 0.05)',
                                    borderRadius: '4px',
                                    padding: '6px 8px',
                                    fontSize: '11px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px'
                                }}
                            >
                                <span style={{ opacity: 0.6 }}>
                                    {result.isDirectory ? '📁' : '📄'}
                                </span>
                                <span style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    flex: 1
                                }}>
                                    {result.name}
                                </span>
                            </div>
                        ))}
                        {results.length > 5 && (
                            <div style={{
                                fontSize: '10px',
                                color: 'rgba(255, 255, 255, 0.5)',
                                textAlign: 'center',
                                padding: '4px'
                            }}>
                                还有 {results.length - 5} 个结果...
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// Export for use in other components
if (typeof window !== 'undefined') {
    window.SearchProgress = SearchProgress;
}