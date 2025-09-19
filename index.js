/**
 * Main application entry point
 */

// Import required modules
const express = require('express');
const path = require('path');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple health check endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'File Transfer UI System is running',
    status: 'healthy'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`File Transfer UI Server running on port ${PORT}`);
});

module.exports = app;