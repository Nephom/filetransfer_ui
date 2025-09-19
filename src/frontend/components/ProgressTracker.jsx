/**
 * Progress Tracker Component
 * Displays real-time progress for file transfers with futuristic design
 */

import React, { useState, useEffect } from 'react';

const ProgressTracker = ({ transferId, onProgressUpdate }) => {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('pending');
  const [fileName, setFileName] = useState('');
  const [speed, setSpeed] = useState(0);
  const [remainingTime, setRemainingTime] = useState(0);

  // Simulate progress updates (in a real app, this would come from WebSocket or API)
  useEffect(() => {
    if (!transferId) return;

    // Simulate progress updates
    const interval = setInterval(() => {
      setProgress(prev => {
        const newProgress = Math.min(prev + Math.random() * 5, 100);
        setStatus(newProgress >= 100 ? 'completed' : 'in_progress');

        // Call parent callback
        if (onProgressUpdate) {
          onProgressUpdate({
            transferId,
            progress: newProgress,
            status: newProgress >= 100 ? 'completed' : 'in_progress'
          });
        }

        return newProgress;
      });
    }, 500);

    return () => clearInterval(interval);
  }, [transferId, onProgressUpdate]);

  const getProgressColor = () => {
    if (status === 'completed') return 'bg-green-500';
    if (status === 'in_progress') return 'bg-blue-500';
    return 'bg-gray-300';
  };

  const getStatusText = () => {
    switch (status) {
      case 'completed': return 'Completed';
      case 'in_progress': return 'In Progress';
      case 'pending': return 'Pending';
      default: return 'Unknown';
    }
  };

  return (
    <div className="bg-gray-900 rounded-xl p-6 shadow-2xl border border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-bold text-white">Transfer Progress</h3>
        <span className={`px-3 py-1 rounded-full text-sm font-medium ${
          status === 'completed' ? 'bg-green-900 text-green-200' :
          status === 'in_progress' ? 'bg-blue-900 text-blue-200' :
          'bg-gray-700 text-gray-300'
        }`}>
          {getStatusText()}
        </span>
      </div>

      <div className="mb-4">
        <div className="flex justify-between text-sm text-gray-300 mb-1">
          <span>Progress</span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full ${getProgressColor()} transition-all duration-300 ease-out`}
            style={{ width: `${progress}%` }}
          ></div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-gray-400">Speed</p>
          <p className="text-white font-mono">{speed.toFixed(1)} KB/s</p>
        </div>
        <div>
          <p className="text-gray-400">Time Remaining</p>
          <p className="text-white">{remainingTime}s</p>
        </div>
      </div>

      <div className="mt-4 text-center">
        <p className="text-gray-300 text-sm">File: {fileName || 'Unknown file'}</p>
      </div>
    </div>
  );
};

export default ProgressTracker;