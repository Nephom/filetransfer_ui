// File List Component
const FileList = ({ files, searchQuery, onClearSearch, getFileIcon, error }) => {
    return (
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
            ) : files.length === 0 ? (
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
                                onClick={onClearSearch}
                                style={{
                                    background: 'rgba(59, 130, 246, 0.2)',
                                    border: '1px solid rgba(59, 130, 246, 0.5)',
                                    borderRadius: '8px',
                                    color: 'white',
                                    padding: '8px 16px',
                                    cursor: 'pointer',
                                    fontSize: '14px',
                                    outline: 'none',
                                    backdropFilter: 'blur(10px)',
                                    transition: 'all 0.3s ease'
                                }}
                                onMouseEnter={(e) => {
                                    e.target.style.background = 'rgba(59, 130, 246, 0.3)';
                                }}
                                onMouseLeave={(e) => {
                                    e.target.style.background = 'rgba(59, 130, 246, 0.2)';
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
                    {files.map((file, index) => (
                        <FileItem 
                            key={index}
                            file={file}
                            icon={getFileIcon(file)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

// File Item Component
const FileItem = ({ file, icon }) => {
    return (
        <div
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
                    {icon}
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
    );
};
