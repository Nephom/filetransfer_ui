/**
 * File Browser Component
 * Futuristic file browser with modern UI elements
 */

import React, { useState, useEffect } from 'react';

const FileBrowser = ({ files, onFileSelect, onFolderChange }) => {
  const [currentPath, setCurrentPath] = useState('/');
  const [selectedFile, setSelectedFile] = useState(null);
  const [viewMode, setViewMode] = useState('grid'); // 'grid' or 'list'

  // Mock file data
  const [fileList, setFileList] = useState([
    { id: '1', name: 'Documents', type: 'folder', size: '0 B', modified: '2023-01-01', path: '/Documents' },
    { id: '2', name: 'Photos', type: 'folder', size: '0 B', modified: '2023-01-02', path: '/Photos' },
    { id: '3', name: 'project.zip', type: 'file', size: '2.4 MB', modified: '2023-01-03', path: '/project.zip' },
    { id: '4', name: 'report.pdf', type: 'file', size: '1.2 MB', modified: '2023-01-04', path: '/report.pdf' },
    { id: '5', name: 'presentation.pptx', type: 'file', size: '5.7 MB', modified: '2023-01-05', path: '/presentation.pptx' },
  ]);

  const handleFileSelect = (file) => {
    setSelectedFile(file);
    if (onFileSelect) {
      onFileSelect(file);
    }
  };

  const handleFolderClick = (folderPath) => {
    setCurrentPath(folderPath);
    if (onFolderChange) {
      onFolderChange(folderPath);
    }
  };

  const getFileIcon = (type) => {
    if (type === 'folder') {
      return (
        <svg className="w-8 h-8 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
          <path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 002 2h6a2 2 0 002-2V4a2 2 0 00-2-2H4a2 2 0 00-2 2v2zm10 0a1 1 0 011-1h4a1 1 0 011 1v8a1 1 0 01-1 1h-4a1 1 0 01-1-1V6z" />
        </svg>
      );
    }
    return (
      <svg className="w-8 h-8 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586V7h3a2 2 0 012 2v7a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
      </svg>
    );
  };

  const renderFileItem = (file) => (
    <div
      key={file.id}
      className={`p-4 rounded-lg cursor-pointer transition-all duration-200 hover:bg-gray-800 ${
        selectedFile?.id === file.id ? 'bg-blue-900 border border-blue-500' : ''
      }`}
      onClick={() => handleFileSelect(file)}
    >
      <div className="flex items-center space-x-3">
        {getFileIcon(file.type)}
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium truncate">{file.name}</p>
          <div className="flex text-sm text-gray-400 space-x-2">
            <span>{file.size}</span>
            <span>•</span>
            <span>{file.modified}</span>
          </div>
        </div>
      </div>
    </div>
  );

  const renderFileList = (files) => (
    <div className="space-y-2">
      {files.map(renderFileItem)}
    </div>
  );

  const renderFileGrid = (files) => (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {files.map(renderFileItem)}
    </div>
  );

  return (
    <div className="bg-gray-900 rounded-xl p-6 shadow-2xl border border-gray-700">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">File Browser</h2>
        <div className="flex space-x-2">
          <button
            className={`p-2 rounded-lg ${viewMode === 'grid' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
            onClick={() => setViewMode('grid')}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
            </svg>
          </button>
          <button
            className={`p-2 rounded-lg ${viewMode === 'list' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
            onClick={() => setViewMode('list')}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex items-center space-x-2 text-sm text-gray-400">
          <span>Current Path:</span>
          <span className="text-blue-400 font-mono">{currentPath}</span>
        </div>
      </div>

      <div className="mb-6">
        {viewMode === 'grid' ? renderFileGrid(fileList) : renderFileList(fileList)}
      </div>

      <div className="flex justify-between">
        <button className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors duration-200">
          New Folder
        </button>
        <button className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors duration-200">
          Upload Files
        </button>
      </div>
    </div>
  );
};

export default FileBrowser;