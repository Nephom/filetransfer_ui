// Share Modal Component
const ShareModal = ({ file, onClose, token }) => {
    const [expirationOption, setExpirationOption] = useState('86400'); // 1 day
    const [maxDownloads, setMaxDownloads] = useState('0'); // unlimited
    const [password, setPassword] = useState('');
    const [usePassword, setUsePassword] = useState(false);
    const [shareUrl, setShareUrl] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState('');
    const [copySuccess, setCopySuccess] = useState(false);

    const expirationOptions = [
        { value: '3600', label: '1 Hour' },
        { value: '86400', label: '1 Day' },
        { value: '604800', label: '7 Days' },
        { value: '2592000', label: '30 Days' },
        { value: '0', label: 'Never' }
    ];

    const downloadOptions = [
        { value: '1', label: '1 Download' },
        { value: '10', label: '10 Downloads' },
        { value: '100', label: '100 Downloads' },
        { value: '0', label: 'Unlimited' }
    ];

    const handleGenerateLink = async () => {
        setIsGenerating(true);
        setError('');

        try {
            const response = await fetch('/api/files/share', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    filePath: file.path || file.name,
                    expiresIn: parseInt(expirationOption),
                    maxDownloads: parseInt(maxDownloads),
                    password: usePassword ? password : undefined
                })
            });

            if (response.ok) {
                const data = await response.json();
                setShareUrl(data.data.fullUrl);
            } else {
                const errorData = await response.json();
                setError(errorData.message || 'Failed to create share link');
            }
        } catch (error) {
            console.error('Error creating share link:', error);
            setError('Failed to create share link');
        } finally {
            setIsGenerating(false);
        }
    };

    const handleCopyToClipboard = async () => {
        try {
            await navigator.clipboard.writeText(shareUrl);
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        } catch (error) {
            console.error('Failed to copy:', error);
        }
    };

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px'
        }}
        onClick={onClose}>
            <div style={{
                background: 'rgba(30, 30, 46, 0.95)',
                backdropFilter: 'blur(20px)',
                borderRadius: '20px',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                padding: '32px',
                maxWidth: '500px',
                width: '100%',
                boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)'
            }}
            onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '24px'
                }}>
                    <h2 style={{
                        color: 'white',
                        margin: 0,
                        fontSize: '24px',
                        fontWeight: '600'
                    }}>
                        Share File
                    </h2>
                    <button onClick={onClose} style={{
                        background: 'none',
                        border: 'none',
                        color: 'rgba(255, 255, 255, 0.6)',
                        fontSize: '24px',
                        cursor: 'pointer',
                        padding: '0',
                        width: '32px',
                        height: '32px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '8px',
                        transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => {
                        e.target.style.background = 'rgba(255, 255, 255, 0.1)';
                        e.target.style.color = 'white';
                    }}
                    onMouseLeave={(e) => {
                        e.target.style.background = 'none';
                        e.target.style.color = 'rgba(255, 255, 255, 0.6)';
                    }}>
                        ✕
                    </button>
                </div>

                {/* File Info */}
                <div style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    borderRadius: '12px',
                    padding: '16px',
                    marginBottom: '24px',
                    border: '1px solid rgba(255, 255, 255, 0.1)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '32px' }}>📄</span>
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
                        </div>
                    </div>
                </div>

                {!shareUrl ? (
                    <>
                        {/* Expiration */}
                        <div style={{ marginBottom: '20px' }}>
                            <label style={{
                                display: 'block',
                                color: 'rgba(255, 255, 255, 0.9)',
                                fontSize: '14px',
                                fontWeight: '500',
                                marginBottom: '8px'
                            }}>
                                Expiration
                            </label>
                            <select
                                value={expirationOption}
                                onChange={(e) => setExpirationOption(e.target.value)}
                                style={{
                                    width: '100%',
                                    padding: '12px',
                                    background: 'rgba(255, 255, 255, 0.1)',
                                    border: '1px solid rgba(255, 255, 255, 0.2)',
                                    borderRadius: '10px',
                                    color: 'white',
                                    fontSize: '14px',
                                    outline: 'none',
                                    cursor: 'pointer'
                                }}>
                                {expirationOptions.map(option => (
                                    <option key={option.value} value={option.value} style={{ background: '#1e1e2e' }}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Max Downloads */}
                        <div style={{ marginBottom: '20px' }}>
                            <label style={{
                                display: 'block',
                                color: 'rgba(255, 255, 255, 0.9)',
                                fontSize: '14px',
                                fontWeight: '500',
                                marginBottom: '8px'
                            }}>
                                Maximum Downloads
                            </label>
                            <select
                                value={maxDownloads}
                                onChange={(e) => setMaxDownloads(e.target.value)}
                                style={{
                                    width: '100%',
                                    padding: '12px',
                                    background: 'rgba(255, 255, 255, 0.1)',
                                    border: '1px solid rgba(255, 255, 255, 0.2)',
                                    borderRadius: '10px',
                                    color: 'white',
                                    fontSize: '14px',
                                    outline: 'none',
                                    cursor: 'pointer'
                                }}>
                                {downloadOptions.map(option => (
                                    <option key={option.value} value={option.value} style={{ background: '#1e1e2e' }}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Password Protection */}
                        <div style={{ marginBottom: '24px' }}>
                            <label style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                cursor: 'pointer',
                                marginBottom: '12px'
                            }}>
                                <input
                                    type="checkbox"
                                    checked={usePassword}
                                    onChange={(e) => setUsePassword(e.target.checked)}
                                    style={{ cursor: 'pointer' }}
                                />
                                <span style={{
                                    color: 'rgba(255, 255, 255, 0.9)',
                                    fontSize: '14px',
                                    fontWeight: '500'
                                }}>
                                    Password Protection
                                </span>
                            </label>
                            {usePassword && (
                                <input
                                    type="text"
                                    placeholder="Enter password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    style={{
                                        width: '100%',
                                        padding: '12px',
                                        background: 'rgba(255, 255, 255, 0.1)',
                                        border: '1px solid rgba(255, 255, 255, 0.2)',
                                        borderRadius: '10px',
                                        color: 'white',
                                        fontSize: '14px',
                                        outline: 'none',
                                        boxSizing: 'border-box'
                                    }}
                                />
                            )}
                        </div>

                        {/* Error Message */}
                        {error && (
                            <div style={{
                                padding: '12px',
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                borderRadius: '8px',
                                color: '#ef4444',
                                fontSize: '14px',
                                marginBottom: '20px'
                            }}>
                                {error}
                            </div>
                        )}

                        {/* Generate Button */}
                        <button
                            onClick={handleGenerateLink}
                            disabled={isGenerating || (usePassword && !password.trim())}
                            style={{
                                width: '100%',
                                padding: '14px',
                                background: isGenerating || (usePassword && !password.trim())
                                    ? 'rgba(255, 255, 255, 0.1)'
                                    : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                                border: 'none',
                                borderRadius: '12px',
                                color: 'white',
                                fontSize: '16px',
                                fontWeight: '600',
                                cursor: isGenerating || (usePassword && !password.trim()) ? 'not-allowed' : 'pointer',
                                transition: 'all 0.3s ease',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '8px'
                            }}>
                            {isGenerating ? (
                                <>
                                    <div style={{
                                        width: '16px',
                                        height: '16px',
                                        border: '2px solid rgba(255, 255, 255, 0.3)',
                                        borderTop: '2px solid white',
                                        borderRadius: '50%',
                                        animation: 'spin 1s linear infinite'
                                    }}></div>
                                    Generating...
                                </>
                            ) : (
                                <>
                                    <span>🔗</span>
                                    Generate Link
                                </>
                            )}
                        </button>
                    </>
                ) : (
                    <>
                        {/* Share URL */}
                        <div style={{ marginBottom: '20px' }}>
                            <label style={{
                                display: 'block',
                                color: 'rgba(255, 255, 255, 0.9)',
                                fontSize: '14px',
                                fontWeight: '500',
                                marginBottom: '8px'
                            }}>
                                Share Link
                            </label>
                            <div style={{
                                display: 'flex',
                                gap: '12px'
                            }}>
                                <input
                                    type="text"
                                    value={shareUrl}
                                    readOnly
                                    style={{
                                        flex: 1,
                                        padding: '12px',
                                        background: 'rgba(255, 255, 255, 0.05)',
                                        border: '1px solid rgba(255, 255, 255, 0.2)',
                                        borderRadius: '10px',
                                        color: 'white',
                                        fontSize: '14px',
                                        outline: 'none'
                                    }}
                                />
                                <button
                                    onClick={handleCopyToClipboard}
                                    style={{
                                        padding: '12px 20px',
                                        background: copySuccess
                                            ? 'linear-gradient(135deg, #10b981, #059669)'
                                            : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                                        border: 'none',
                                        borderRadius: '10px',
                                        color: 'white',
                                        fontSize: '14px',
                                        fontWeight: '600',
                                        cursor: 'pointer',
                                        transition: 'all 0.3s ease',
                                        whiteSpace: 'nowrap'
                                    }}>
                                    {copySuccess ? '✓ Copied' : '📋 Copy'}
                                </button>
                            </div>
                        </div>

                        {/* Success Message */}
                        <div style={{
                            padding: '16px',
                            background: 'rgba(16, 185, 129, 0.1)',
                            border: '1px solid rgba(16, 185, 129, 0.3)',
                            borderRadius: '12px',
                            color: '#10b981',
                            fontSize: '14px',
                            marginBottom: '20px',
                            textAlign: 'center'
                        }}>
                            ✓ Share link created successfully!
                        </div>

                        {/* Close Button */}
                        <button
                            onClick={onClose}
                            style={{
                                width: '100%',
                                padding: '14px',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '12px',
                                color: 'white',
                                fontSize: '16px',
                                fontWeight: '600',
                                cursor: 'pointer',
                                transition: 'all 0.3s ease'
                            }}
                            onMouseEnter={(e) => {
                                e.target.style.background = 'rgba(255, 255, 255, 0.15)';
                            }}
                            onMouseLeave={(e) => {
                                e.target.style.background = 'rgba(255, 255, 255, 0.1)';
                            }}>
                            Close
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};
