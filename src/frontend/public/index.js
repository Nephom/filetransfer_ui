// Entry point for the application
// Import all components

// For Node.js environment (testing)
if (typeof require !== 'undefined') {
    var React = require('react');
    var ReactDOM = require('react-dom');
    const { App } = require('./App');
} 

// For browser environment
if (typeof window !== 'undefined' && !window.React) {
    // If React isn't loaded, we'll use CDN version that should be loaded in HTML
    window.React = window.React || React;
    window.ReactDOM = window.ReactDOM || ReactDOM;
}

// Initialize the app if DOM is available
document.addEventListener('DOMContentLoaded', () => {
    const rootElement = document.getElementById('root');
    if (rootElement && window.ReactDOM && window.React) {
        // Try to render the app
        try {
            const appElement = React.createElement(App || window.FileTransferApp?.App, {});
            ReactDOM.render(appElement, rootElement);
        } catch (error) {
            console.error('Error initializing app:', error);
            rootElement.innerHTML = '<div style="padding: 20px; color: white; font-family: Arial, sans-serif; text-align: center;">Error loading application: ' + error.message + '</div>';
        }
    }
});