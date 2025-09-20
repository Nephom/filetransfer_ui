// Security Feature Toggle Component
const SecurityFeatureToggle = ({ feature, enabled, onChange }) => {
    return (
        <div style={{
            background: 'rgba(255, 255, 255, 0.1)',
            backdropFilter: 'blur(10px)',
            borderRadius: '12px',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            padding: '16px',
            transition: 'all 0.3s ease'
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                <div style={{ flex: 1 }}>
                    <h4 style={{ color: 'white', margin: 0, fontSize: '16px', fontWeight: '600' }}>
                        {feature.name}
                    </h4>
                    <p style={{ color: 'rgba(255, 255, 255, 0.8)', margin: 0, fontSize: '14px', marginTop: '4px' }}>
                        {feature.description}
                    </p>
                </div>
                <label style={{
                    position: 'relative',
                    display: 'inline-block',
                    width: '48px',
                    height: '24px',
                    cursor: 'pointer'
                }}>
                    <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => onChange(e.target.checked)}
                        style={{ display: 'none' }}
                    />
                    <div style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        background: enabled ? 
                            'linear-gradient(135deg, #3b82f6, #8b5cf6)' : 
                            'rgba(255, 255, 255, 0.2)',
                        borderRadius: '12px',
                        transition: 'all 0.3s ease',
                        border: '1px solid rgba(255, 255, 255, 0.3)'
                    }}>
                        <div style={{
                            position: 'absolute',
                            top: '2px',
                            left: enabled ? '26px' : '2px',
                            width: '18px',
                            height: '18px',
                            background: 'white',
                            borderRadius: '50%',
                            transition: 'all 0.3s ease',
                            boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)'
                        }}></div>
                    </div>
                </label>
            </div>
        </div>
    );
};
