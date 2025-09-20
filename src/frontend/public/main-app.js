// File Transfer UI - Main Application
console.log('App: Starting...');

// Check dependencies
if (typeof React === 'undefined' || typeof ReactDOM === 'undefined') {
    console.error('App: React dependencies missing');
    document.getElementById('root').innerHTML = `
        <div style="
            min-height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            text-align: center;
            padding: 20px;
        ">
            <div style="
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(20px);
                border-radius: 20px;
                padding: 40px;
                border: 1px solid rgba(255, 255, 255, 0.2);
            ">
                <h2 style="margin: 0 0 16px 0; color: #ef4444;">❌ Dependencies Missing</h2>
                <p style="margin: 0; opacity: 0.8;">React or ReactDOM failed to load.</p>
            </div>
        </div>
    `;
} else {
    console.log('App: Dependencies OK');
    
    // Login Form Component
    const LoginForm = ({ onLogin }) => {
        const [credentials, setCredentials] = React.useState({ username: '', password: '' });
        const [loading, setLoading] = React.useState(false);
        const [error, setError] = React.useState('');

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

        return React.createElement('div', {
            style: {
                minHeight: '100vh',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                overflow: 'hidden'
            }
        }, [
            // Background elements
            React.createElement('div', {
                key: 'bg1',
                style: {
                    position: 'absolute',
                    top: '-160px',
                    right: '-160px',
                    width: '320px',
                    height: '320px',
                    background: 'rgba(147, 51, 234, 0.3)',
                    borderRadius: '50%',
                    filter: 'blur(40px)',
                    animation: 'pulse 4s ease-in-out infinite'
                }
            }),
            React.createElement('div', {
                key: 'bg2',
                style: {
                    position: 'absolute',
                    bottom: '-160px',
                    left: '-160px',
                    width: '320px',
                    height: '320px',
                    background: 'rgba(59, 130, 246, 0.3)',
                    borderRadius: '50%',
                    filter: 'blur(40px)',
                    animation: 'pulse 4s ease-in-out infinite 2s'
                }
            }),
            
            // Main form
            React.createElement('div', {
                key: 'form',
                style: {
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
                }
            }, [
                // Header
                React.createElement('div', {
                    key: 'header',
                    style: { textAlign: 'center', marginBottom: '32px' }
                }, [
                    React.createElement('div', {
                        key: 'icon',
                        style: {
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: '80px',
                            height: '80px',
                            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                            borderRadius: '50%',
                            marginBottom: '16px',
                            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
                            fontSize: '32px'
                        }
                    }, '📁'),
                    React.createElement('h2', {
                        key: 'title',
                        style: {
                            color: 'white',
                            margin: 0,
                            fontSize: '28px',
                            fontWeight: 'bold',
                            marginBottom: '8px'
                        }
                    }, 'File Transfer UI'),
                    React.createElement('p', {
                        key: 'subtitle',
                        style: {
                            color: 'rgba(255, 255, 255, 0.8)',
                            margin: 0,
                            fontSize: '16px'
                        }
                    }, 'Futuristic File Management System')
                ]),

                // Error message
                error && React.createElement('div', {
                    key: 'error',
                    style: {
                        background: 'rgba(239, 68, 68, 0.2)',
                        border: '1px solid rgba(239, 68, 68, 0.5)',
                        color: 'white',
                        padding: '12px 16px',
                        borderRadius: '12px',
                        marginBottom: '24px',
                        backdropFilter: 'blur(10px)',
                        display: 'flex',
                        alignItems: 'center'
                    }
                }, [
                    React.createElement('span', {
                        key: 'icon',
                        style: { marginRight: '8px' }
                    }, '⚠️'),
                    React.createElement('span', { key: 'text' }, error)
                ]),

                // Form
                React.createElement('form', {
                    key: 'form',
                    onSubmit: handleSubmit
                }, [
                    // Username field
                    React.createElement('div', {
                        key: 'username',
                        style: { marginBottom: '24px' }
                    }, [
                        React.createElement('label', {
                            key: 'label',
                            style: {
                                display: 'block',
                                color: 'rgba(255, 255, 255, 0.9)',
                                marginBottom: '8px',
                                fontSize: '14px',
                                fontWeight: '500'
                            }
                        }, 'Username'),
                        React.createElement('input', {
                            key: 'input',
                            type: 'text',
                            value: credentials.username,
                            onChange: (e) => setCredentials({...credentials, username: e.target.value}),
                            style: {
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
                            },
                            placeholder: 'Enter your username',
                            required: true
                        })
                    ]),

                    // Password field
                    React.createElement('div', {
                        key: 'password',
                        style: { marginBottom: '32px' }
                    }, [
                        React.createElement('label', {
                            key: 'label',
                            style: {
                                display: 'block',
                                color: 'rgba(255, 255, 255, 0.9)',
                                marginBottom: '8px',
                                fontSize: '14px',
                                fontWeight: '500'
                            }
                        }, 'Password'),
                        React.createElement('input', {
                            key: 'input',
                            type: 'password',
                            value: credentials.password,
                            onChange: (e) => setCredentials({...credentials, password: e.target.value}),
                            style: {
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
                            },
                            placeholder: 'Enter your password',
                            required: true
                        })
                    ]),

                    // Submit button
                    React.createElement('button', {
                        key: 'submit',
                        type: 'submit',
                        disabled: loading,
                        style: {
                            width: '100%',
                            background: loading ? 'rgba(59, 130, 246, 0.5)' : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                            border: 'none',
                            borderRadius: '12px',
                            color: 'white',
                            fontSize: '16px',
                            fontWeight: '600',
                            padding: '16px',
                            cursor: loading ? 'not-allowed' : 'pointer',
                            transition: 'all 0.3s ease',
                            boxShadow: '0 4px 15px rgba(0, 0, 0, 0.2)',
                            outline: 'none'
                        }
                    }, loading ? 'Logging in...' : '🚀 Login')
                ]),

                // Info
                React.createElement('div', {
                    key: 'info',
                    style: {
                        textAlign: 'center',
                        marginTop: '24px',
                        background: 'rgba(59, 130, 246, 0.2)',
                        border: '1px solid rgba(59, 130, 246, 0.3)',
                        borderRadius: '12px',
                        padding: '16px',
                        backdropFilter: 'blur(10px)'
                    }
                }, React.createElement('p', {
                    style: {
                        color: 'rgba(255, 255, 255, 0.9)',
                        margin: 0,
                        fontSize: '14px'
                    }
                }, 'Default: admin / password'))
            ])
        ]);
    };

    // File Browser Component
    const FileBrowser = ({ token, user }) => {
        const [files, setFiles] = React.useState([]);
        const [loading, setLoading] = React.useState(true);
        const [error, setError] = React.useState('');

        React.useEffect(() => {
            fetchFiles();
        }, []);

        const fetchFiles = async () => {
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
                setError('Connection error');
            } finally {
                setLoading(false);
            }
        };

        const handleLogout = () => {
            localStorage.removeItem('token');
            window.location.reload();
        };

        if (loading) {
            return React.createElement('div', {
                style: {
                    minHeight: '100vh',
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white'
                }
            }, React.createElement('div', {
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '20px',
                    padding: '40px',
                    textAlign: 'center',
                    border: '1px solid rgba(255, 255, 255, 0.2)'
                }
            }, [
                React.createElement('div', {
                    key: 'spinner',
                    style: {
                        width: '40px',
                        height: '40px',
                        border: '3px solid rgba(255, 255, 255, 0.3)',
                        borderTop: '3px solid white',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite',
                        margin: '0 auto 20px'
                    }
                }),
                React.createElement('p', {
                    key: 'text',
                    style: { margin: 0, fontSize: '18px' }
                }, 'Loading files...')
            ]));
        }

        return React.createElement('div', {
            style: {
                minHeight: '100vh',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }
        }, [
            // Header
            React.createElement('div', {
                key: 'header',
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
                    padding: '16px 24px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                }
            }, [
                React.createElement('div', {
                    key: 'logo',
                    style: { display: 'flex', alignItems: 'center', gap: '12px' }
                }, [
                    React.createElement('div', {
                        key: 'icon',
                        style: {
                            width: '40px',
                            height: '40px',
                            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '20px'
                        }
                    }, '📁'),
                    React.createElement('div', { key: 'text' }, [
                        React.createElement('h1', {
                            key: 'title',
                            style: { margin: 0, fontSize: '20px', fontWeight: 'bold' }
                        }, 'File Transfer UI'),
                        React.createElement('p', {
                            key: 'subtitle',
                            style: { margin: 0, fontSize: '12px', opacity: 0.8 }
                        }, 'Futuristic File Management')
                    ])
                ]),
                React.createElement('div', {
                    key: 'user',
                    style: { display: 'flex', alignItems: 'center', gap: '16px' }
                }, [
                    React.createElement('span', {
                        key: 'welcome',
                        style: { fontSize: '14px' }
                    }, `Welcome, ${user?.username}`),
                    React.createElement('button', {
                        key: 'logout',
                        onClick: handleLogout,
                        style: {
                            background: 'rgba(239, 68, 68, 0.2)',
                            border: '1px solid rgba(239, 68, 68, 0.5)',
                            borderRadius: '8px',
                            color: 'white',
                            padding: '8px 16px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            outline: 'none'
                        }
                    }, '🚪 Logout')
                ])
            ]),

            // Main content
            React.createElement('div', {
                key: 'main',
                style: { padding: '24px' }
            }, React.createElement('div', {
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '20px',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                    overflow: 'hidden'
                }
            }, [
                React.createElement('div', {
                    key: 'toolbar',
                    style: {
                        padding: '20px 24px',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.2)'
                    }
                }, React.createElement('h2', {
                    style: { color: 'white', margin: 0, fontSize: '20px', fontWeight: '600' }
                }, `Files (${files.length})`)),

                React.createElement('div', {
                    key: 'content',
                    style: { padding: '24px' }
                }, error ? React.createElement('div', {
                    style: {
                        textAlign: 'center',
                        padding: '40px',
                        color: '#ef4444'
                    }
                }, [
                    React.createElement('div', {
                        key: 'error-icon',
                        style: { fontSize: '48px', marginBottom: '16px' }
                    }, '❌'),
                    React.createElement('p', {
                        key: 'error-text',
                        style: { margin: 0, fontSize: '16px' }
                    }, error)
                ]) : files.length === 0 ? React.createElement('div', {
                    style: {
                        textAlign: 'center',
                        padding: '60px',
                        color: 'rgba(255, 255, 255, 0.8)'
                    }
                }, [
                    React.createElement('div', {
                        key: 'empty-icon',
                        style: { fontSize: '64px', marginBottom: '16px' }
                    }, '📁'),
                    React.createElement('p', {
                        key: 'empty-text',
                        style: { margin: 0, fontSize: '18px' }
                    }, 'This folder is empty')
                ]) : React.createElement('div', {
                    style: {
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                        gap: '16px'
                    }
                }, files.map((file, index) => React.createElement('div', {
                    key: index,
                    style: {
                        background: 'rgba(255, 255, 255, 0.1)',
                        backdropFilter: 'blur(10px)',
                        borderRadius: '12px',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        padding: '16px',
                        cursor: 'pointer',
                        transition: 'all 0.3s ease',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px'
                    }
                }, [
                    React.createElement('div', {
                        key: 'icon',
                        style: { fontSize: '32px' }
                    }, file.name.includes('.') ? '📄' : '📂'),
                    React.createElement('div', {
                        key: 'info',
                        style: { flex: 1, minWidth: 0 }
                    }, [
                        React.createElement('p', {
                            key: 'name',
                            style: {
                                color: 'white',
                                margin: 0,
                                fontSize: '16px',
                                fontWeight: '500',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                            }
                        }, file.name),
                        React.createElement('p', {
                            key: 'type',
                            style: {
                                color: 'rgba(255, 255, 255, 0.7)',
                                margin: 0,
                                fontSize: '12px',
                                marginTop: '4px'
                            }
                        }, file.name.includes('.') ? 'File' : 'Folder')
                    ])
                ])))
            ])
        ]);
    };

    // Main App Component
    const App = () => {
        const [user, setUser] = React.useState(null);
        const [token, setToken] = React.useState(localStorage.getItem('token'));
        const [isLoading, setIsLoading] = React.useState(true);

        React.useEffect(() => {
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
            return React.createElement('div', {
                style: {
                    minHeight: '100vh',
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }
            }, React.createElement('div', {
                style: {
                    background: 'rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(20px)',
                    borderRadius: '20px',
                    padding: '40px',
                    textAlign: 'center',
                    border: '1px solid rgba(255, 255, 255, 0.2)'
                }
            }, [
                React.createElement('div', {
                    key: 'spinner',
                    style: {
                        width: '60px',
                        height: '60px',
                        border: '4px solid rgba(255, 255, 255, 0.3)',
                        borderTop: '4px solid white',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite',
                        margin: '0 auto 20px'
                    }
                }),
                React.createElement('p', {
                    key: 'text',
                    style: { color: 'white', margin: 0, fontSize: '18px' }
                }, 'Initializing futuristic file manager...')
            ]));
        }

        if (!token || !user) {
            return React.createElement(LoginForm, { onLogin: handleLogin });
        }

        return React.createElement(FileBrowser, { token: token, user: user });
    };

    // Add CSS animations
    const style = document.createElement('style');
    style.textContent = `
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
    `;
    document.head.appendChild(style);

    // Render the app
    try {
        console.log('App: Rendering...');
        ReactDOM.render(React.createElement(App), document.getElementById('root'));
        console.log('App: Rendered successfully!');
    } catch (error) {
        console.error('App: Render failed:', error);
        document.getElementById('root').innerHTML = `
            <div style="
                min-height: 100vh;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                text-align: center;
                padding: 20px;
            ">
                <div style="
                    background: rgba(255, 255, 255, 0.1);
                    backdrop-filter: blur(20px);
                    border-radius: 20px;
                    padding: 40px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                ">
                    <h2 style="margin: 0 0 16px 0; color: #ef4444;">❌ Render Failed</h2>
                    <p style="margin: 0; opacity: 0.8;">Error: ${error.message}</p>
                </div>
            </div>
        `;
    }
}
