// Main application entry point
// This file replaces the original large app.js with modular imports

// First, let's ensure we have React available
const React = window.React;
const ReactDOM = window.ReactDOM;

// Import our components by executing their definitions
// Since we used CommonJS exports, we'll access them differently in browser

// The components are included as separate files now
// LoginForm, FileBrowser, and App are defined in their respective files

// For browser usage, we'll reference the components defined in the global scope
// or access them from the window object where we stored them

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const rootElement = document.getElementById('root');
    if (rootElement && window.ReactDOM && window.React && window.FileTransferApp?.App) {
        try {
            const App = window.FileTransferApp.App;
            const appElement = React.createElement(App, {});
            ReactDOM.render(appElement, rootElement);
        } catch (error) {
            console.error('Error initializing app:', error);
            const loadingTextElement = document.getElementById('loading-text');
            if (loadingTextElement) {
                loadingTextElement.innerHTML = `
                    <p style="color: #ef4444; margin: 0; font-size: 18px;">
                        Error loading application: ${error.message}
                    </p>
                `;
            }
        }
    } else {
        console.error('Required components not available');
        const loadingTextElement = document.getElementById('loading-text');
        if (loadingTextElement) {
            loadingTextElement.innerHTML = `
                <p style="color: #ef4444; margin: 0; font-size: 18px;">
                    Failed to load required components
                </p>
            `;
        }
    }
});