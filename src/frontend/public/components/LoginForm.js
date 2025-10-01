// Make LoginForm component available globally (must be before the component definition)
if (!window.FileTransferApp) {
    window.FileTransferApp = {};
}

const LoginForm = ({ onLogin }) => {
    const [credentials, setCredentials] = React.useState({ username: '', password: '' });
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const [showForgotPassword, setShowForgotPassword] = React.useState(false);
    const [forgotPasswordUsername, setForgotPasswordUsername] = React.useState('');
    const [forgotPasswordLoading, setForgotPasswordLoading] = React.useState(false);
    const [forgotPasswordSuccess, setForgotPasswordSuccess] = React.useState('');

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

    const handleForgotPassword = async (e) => {
        e.preventDefault();
        setForgotPasswordLoading(true);
        setForgotPasswordSuccess('');
        
        try {
            const response = await fetch('/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: forgotPasswordUsername })
            });
            
            const data = await response.json();
            
            if (response.ok) {
                setForgotPasswordSuccess('Password reset link sent to your email');
                setForgotPasswordUsername('');
            } else {
                setError(data.error || 'Failed to send reset link');
            }
        } catch (err) {
            setError('Connection error');
        } finally {
            setForgotPasswordLoading(false);
        }
    };

    return React.createElement('div', {
        style: {
            width: '100%',
            height: '100vh',
            background: 'linear-gradient(135deg, #2c3e50 0%, #34495e 25%, #5d6d7e 50%, #85929e 75%, #aeb6bf 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'Arial, sans-serif'
        }
    }, 
        React.createElement('div', {
            key: 'login-container',
            style: {
                background: 'rgba(52, 73, 94, 0.3)',
                backdropFilter: 'blur(15px)',
                borderRadius: '16px',
                padding: '40px',
                width: '400px',
                boxShadow: '0 12px 40px rgba(0, 0, 0, 0.2)',
                border: '1px solid rgba(173, 181, 189, 0.3)'
            }
        }, [
            React.createElement('div', {
                key: 'header-section',
                style: { 
                    textAlign: 'center', 
                    marginBottom: '30px' 
                }
            }, [
                React.createElement('h1', {
                    key: 'title',
                    style: { 
                        color: 'white', 
                        margin: 0, 
                        fontSize: '28px' 
                    }
                }, 'File Transfer'),
                React.createElement('p', {
                    key: 'subtitle',
                    style: { 
                        color: 'rgba(255, 255, 255, 0.8)', 
                        margin: '10px 0 0 0' 
                    }
                }, 'Secure file sharing')
            ]),

            showForgotPassword ? React.createElement('form', {
                key: 'forgot-password-form',
                onSubmit: handleForgotPassword,
                style: { display: 'flex', flexDirection: 'column', gap: '16px' }
            }, [
                error && React.createElement('div', {
                    key: 'error-message',
                    style: { 
                        color: '#ef4444', 
                        textAlign: 'center',
                        padding: '12px',
                        background: 'rgba(239, 68, 68, 0.1)',
                        borderRadius: '8px'
                    }
                }, error),
                
                React.createElement('input', {
                    key: 'username-input',
                    type: 'text',
                    placeholder: 'Username',
                    value: forgotPasswordUsername,
                    onChange: (e) => setForgotPasswordUsername(e.target.value),
                    required: true,
                    style: {
                        padding: '14px',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '8px',
                        background: 'rgba(255, 255, 255, 0.1)',
                        color: 'white',
                        fontSize: '16px'
                    }
                }),
                
                React.createElement('button', {
                    key: 'submit-button',
                    type: 'submit',
                    disabled: forgotPasswordLoading,
                    style: {
                        padding: '14px',
                        background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                        border: 'none',
                        borderRadius: '8px',
                        color: 'white',
                        fontSize: '16px',
                        cursor: 'pointer',
                        transition: 'background 0.2s'
                    }
                }, forgotPasswordLoading ? 'Sending...' : 'Send Reset Link'),
                
                forgotPasswordSuccess && React.createElement('div', {
                    key: 'success-message',
                    style: { 
                        color: '#10b981', 
                        textAlign: 'center',
                        padding: '12px',
                        background: 'rgba(16, 185, 129, 0.1)',
                        borderRadius: '8px'
                    }
                }, forgotPasswordSuccess),
                
                React.createElement('button', {
                    key: 'back-button',
                    type: 'button',
                    onClick: () => {
                        setShowForgotPassword(false);
                        setError('');
                    },
                    style: {
                        padding: '12px',
                        background: 'transparent',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '8px',
                        color: 'white',
                        fontSize: '14px',
                        cursor: 'pointer'
                    }
                }, 'Back to Login')
            ]) : React.createElement('form', {
                key: 'login-form',
                onSubmit: handleSubmit,
                style: { display: 'flex', flexDirection: 'column', gap: '16px' }
            }, [
                error && React.createElement('div', {
                    key: 'error-message',
                    style: { 
                        color: '#ef4444', 
                        textAlign: 'center',
                        padding: '12px',
                        background: 'rgba(239, 68, 68, 0.1)',
                        borderRadius: '8px'
                    }
                }, error),
                
                React.createElement('input', {
                    key: 'username-input',
                    type: 'text',
                    placeholder: 'Username',
                    value: credentials.username,
                    onChange: (e) => setCredentials({...credentials, username: e.target.value}),
                    required: true,
                    style: {
                        padding: '14px',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '8px',
                        background: 'rgba(255, 255, 255, 0.1)',
                        color: 'white',
                        fontSize: '16px'
                    }
                }),
                
                React.createElement('input', {
                    key: 'password-input',
                    type: 'password',
                    placeholder: 'Password',
                    value: credentials.password,
                    onChange: (e) => setCredentials({...credentials, password: e.target.value}),
                    required: true,
                    style: {
                        padding: '14px',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '8px',
                        background: 'rgba(255, 255, 255, 0.1)',
                        color: 'white',
                        fontSize: '16px'
                    }
                }),
                
                React.createElement('button', {
                    key: 'login-button',
                    type: 'submit',
                    disabled: loading,
                    style: {
                        padding: '14px',
                        background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                        border: 'none',
                        borderRadius: '8px',
                        color: 'white',
                        fontSize: '16px',
                        cursor: 'pointer',
                        transition: 'background 0.2s'
                    }
                }, loading ? 'Logging in...' : 'Login'),
                
                React.createElement('div', {
                    key: 'forgot-password-wrapper',
                    style: { 
                        display: 'flex', 
                        justifyContent: 'center' 
                    }
                }, 
                    React.createElement('button', {
                        key: 'forgot-password-button',
                        type: 'button',
                        onClick: () => setShowForgotPassword(true),
                        style: {
                            background: 'none',
                            border: 'none',
                            color: 'rgba(255, 255, 255, 0.7)',
                            cursor: 'pointer',
                            fontSize: '14px'
                        }
                    }, 'Forgot Password?')
                )
            ])
        ])
    );
};

// Make LoginForm component available globally
if (!window.FileTransferApp) {
    window.FileTransferApp = {};
}
window.FileTransferApp.LoginForm = LoginForm;

// Export for use in main app
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LoginForm };
}