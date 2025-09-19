/**
 * Drag and Drop Upload Component
 * Futuristic drag-and-drop interface for file uploads
 */

import React, { useState, useCallback } from 'react';

const DragDropUpload = ({ onFilesUploaded }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('idle'); // 'idle', 'uploading', 'success', 'error'
  const [uploadedFiles, setUploadedFiles] = useState([]);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  }, []);

  const handleFileInput = (e) => {
    const files = Array.from(e.target.files);
    handleFiles(files);
  };

  const handleFiles = (files) => {
    if (files.length === 0) return;

    setUploadStatus('uploading');

    // Simulate upload process
    setTimeout(() => {
      setUploadedFiles(files.map((file, index) => ({
        id: `file-${Date.now()}-${index}`,
        name: file.name,
        size: formatFileSize(file.size),
        type: file.type,
        status: 'uploaded'
      })));

      setUploadStatus('success');

      if (onFilesUploaded) {
        onFilesUploaded(files);
      }
    }, 2000);
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStatusColor = () => {
    switch (uploadStatus) {
      case 'success': return 'border-green-500 bg-green-900/20';
      case 'error': return 'border-red-500 bg-red-900/20';
      case 'uploading': return 'border-blue-500 bg-blue-900/20';
      default: return 'border-gray-600 bg-gray-800/20';
    }
  };

  const getStatusText = () => {
    switch (uploadStatus) {
      case 'success': return 'Upload Successful!';
      case 'error': return 'Upload Failed';
      case 'uploading': return 'Uploading Files...';
      default: return 'Drop files here or click to browse';
    }
  };

  return (
    <div
      className={`border-2 border-dashed rounded-xl p-8 text-center transition-all duration-300 ${
        isDragging ? 'border-blue-500 bg-blue-900/20' : getStatusColor()
      }`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex flex-col items-center justify-center space-y-4">
        <div className="p-3 bg-gray-800 rounded-full">
          <svg className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
        </div>

        <div>
          <p className="text-lg font-medium text-white mb-1">
            {getStatusText()}
          </p>
          <p className="text-gray-400 text-sm">
            {uploadStatus === 'idle' ? 'Supports all file types' : ''}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <label className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg cursor-pointer transition-colors duration-200">
            Browse Files
            <input
              type="file"
              className="hidden"
              multiple
              onChange={handleFileInput}
            />
          </label>

          {uploadStatus === 'uploading' && (
            <button
              className="px-4 py-2 bg-gray-700 text-white rounded-lg cursor-not-allowed"
              disabled
            >
              Cancel
            </button>
          )}
        </div>

        {uploadedFiles.length > 0 && (
          <div className="mt-4 w-full max-w-md">
            <h4 className="text-white text-sm font-medium mb-2">Uploaded Files:</h4>
            <div className="space-y-2">
              {uploadedFiles.map(file => (
                <div key={file.id} className="flex items-center justify-between p-2 bg-gray-800/50 rounded">
                  <div className="flex items-center space-x-2">
                    <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    <span className="text-white text-sm truncate">{file.name}</span>
                  </div>
                  <span className="text-gray-400 text-xs">{file.size}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DragDropUpload;