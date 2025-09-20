// App Loader - Loads all components in the correct order
console.log('App Loader: Starting to load components...');

// Component loading order
const components = [
    '/components/styles.js',
    '/components/security-toggle.js',
    '/components/settings-modal.js',
    '/components/file-list.js',
    '/components/user-dropdown.js',
    '/components/file-browser.js',
    '/components/login.js',
    '/components/app.js'
];

let loadedComponents = 0;
const totalComponents = components.length;

// Function to update loading progress
function updateLoadingProgress() {
    const progress = Math.round((loadedComponents / totalComponents) * 100);
    const loadingElement = document.getElementById('loading-progress');
    if (loadingElement) {
        loadingElement.textContent = `Loading components... ${progress}%`;
    }
}

// Function to load a component
function loadComponent(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.type = 'text/babel';
        script.src = src;
        
        script.onload = () => {
            console.log(`App Loader: Loaded ${src}`);
            loadedComponents++;
            updateLoadingProgress();
            resolve();
        };
        
        script.onerror = () => {
            console.error(`App Loader: Failed to load ${src}`);
            reject(new Error(`Failed to load ${src}`));
        };
        
        document.head.appendChild(script);
    });
}

// Function to load all components sequentially
async function loadAllComponents() {
    try {
        console.log('App Loader: Loading components sequentially...');
        
        for (const component of components) {
            await loadComponent(component);
            // Small delay to ensure proper loading order
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log('App Loader: All components loaded successfully');
        
        // Wait a bit more for Babel to process everything
        setTimeout(() => {
            console.log('App Loader: Rendering main app...');
            try {
                ReactDOM.render(React.createElement(App), document.getElementById('root'));
                console.log('App Loader: App rendered successfully');
            } catch (error) {
                console.error('App Loader: Failed to render app:', error);
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
                            <h2 style="margin: 0 0 16px 0; color: #ef4444;">❌ App Loading Failed</h2>
                            <p style="margin: 0; opacity: 0.8;">Please refresh the page to try again.</p>
                            <button onclick="window.location.reload()" style="
                                margin-top: 20px;
                                padding: 12px 24px;
                                background: linear-gradient(135deg, #3b82f6, #8b5cf6);
                                border: none;
                                border-radius: 8px;
                                color: white;
                                cursor: pointer;
                                font-weight: 600;
                            ">
                                Refresh Page
                            </button>
                        </div>
                    </div>
                `;
            }
        }, 500);
        
    } catch (error) {
        console.error('App Loader: Error loading components:', error);
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
                    <h2 style="margin: 0 0 16px 0; color: #ef4444;">❌ Component Loading Failed</h2>
                    <p style="margin: 0; opacity: 0.8;">Failed to load: ${error.message}</p>
                    <button onclick="window.location.reload()" style="
                        margin-top: 20px;
                        padding: 12px 24px;
                        background: linear-gradient(135deg, #3b82f6, #8b5cf6);
                        border: none;
                        border-radius: 8px;
                        color: white;
                        cursor: pointer;
                        font-weight: 600;
                    ">
                        Refresh Page
                    </button>
                </div>
            </div>
        `;
    }
}

// Check if React and other dependencies are loaded
function checkDependencies() {
    const dependencies = [
        { name: 'React', check: () => typeof React !== 'undefined' },
        { name: 'ReactDOM', check: () => typeof ReactDOM !== 'undefined' },
        { name: 'Babel', check: () => typeof Babel !== 'undefined' }
    ];
    
    const missing = dependencies.filter(dep => !dep.check());
    
    if (missing.length > 0) {
        console.error('App Loader: Missing dependencies:', missing.map(d => d.name));
        return false;
    }
    
    return true;
}

// Initialize the app loader
function initializeAppLoader() {
    console.log('App Loader: Initializing...');
    
    // Update the loading message
    const loadingElement = document.getElementById('loading-text');
    if (loadingElement) {
        loadingElement.innerHTML = `
            <p id="loading-progress" style="margin: 0; font-size: 18px;">
                Initializing futuristic file manager...
            </p>
        `;
    }
    
    // Check dependencies
    if (!checkDependencies()) {
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
                    <p style="margin: 0; opacity: 0.8;">React, ReactDOM, or Babel failed to load.</p>
                    <button onclick="window.location.reload()" style="
                        margin-top: 20px;
                        padding: 12px 24px;
                        background: linear-gradient(135deg, #3b82f6, #8b5cf6);
                        border: none;
                        border-radius: 8px;
                        color: white;
                        cursor: pointer;
                        font-weight: 600;
                    ">
                        Refresh Page
                    </button>
                </div>
            </div>
        `;
        return;
    }
    
    // Start loading components
    loadAllComponents();
}

// Start the initialization process
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAppLoader);
} else {
    initializeAppLoader();
}
