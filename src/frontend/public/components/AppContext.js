const { createContext, useState, useEffect } = React;

const AppContext = createContext();

const AppProvider = ({ children }) => {
  const [files, setFiles] = useState([]);
  const [currentPath, setCurrentPath] = useState('/');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);

  const fetchFiles = async (path, token) => {
    setIsLoading(true);
    setError(null);
    try {
      // If path is not provided, use the currentPath from state.
      const targetPath = path !== undefined ? path : currentPath;
      const url = targetPath && targetPath !== '/' ? `/api/files/${encodeURIComponent(targetPath)}` : '/api/files';
      
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Failed to load files' }));
        throw new Error(errorData.message || 'Failed to load files');
      }

      const data = await response.json();
      setFiles(data);

    } catch (err) {
      setError(err.message || 'A connection error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

        const performSearch = async (query, token) => {
          if (!query.trim()) {
            setSearchResults([]);
            setIsSearching(false);
            setError(null);
            return;
          }
  
          setIsSearching(true);
          setError(null);
          try {
            const response = await fetch(`/api/files/search?query=${encodeURIComponent(query)}&path=`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
  
            if (response.ok) {
              const results = await response.json();
              setSearchResults(results);
            } else {
              setError('Search failed');
              setSearchResults([]);
            }
          } catch (error) {
            console.error('Search error:', error);
            setError(`Search failed: ${error.message}`);
            setSearchResults([]);
          } finally {
            setIsSearching(false);
          }
        };
  
                    const deleteFiles = async (filesToDelete, currentPath, token) => {
                      // No need to set loading, as fetchFiles will handle it.
                      setError(null);
                      try {
                        for (const file of filesToDelete) {
                          const filePath = currentPath ? `${currentPath}/${file.name}` : file.name;
                          const response = await fetch(`/api/files/${encodeURIComponent(filePath)}`, {
                              method: 'DELETE',
                              headers: { 'Authorization': `Bearer ${token}` }
                          });
              
                          if (!response.ok) {
                              throw new Error(`Failed to delete ${file.name}`);
                          }
                        }
                        
                        // Successful deletion - emit event to notify parent components to clear selections
                        window.dispatchEvent(new CustomEvent('filesDeleted', { 
                          detail: { deletedFiles: filesToDelete } 
                        }));
                        
                      } catch (err) {
                        setError(err.message || 'An error occurred during deletion.');
                      } finally {
                        // Refresh the file list after deletion attempt
                        await fetchFiles(currentPath, token);
                      }
                    };        
      const renameFile = async (file, newName, currentPath, token) => {
        setError(null);
        try {
            const response = await fetch('/api/files/rename', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    oldName: file.name,
                    newName: newName,
                    currentPath: currentPath
                })
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Rename failed');
            }
        } catch (err) {
            setError(err.message || 'An error occurred during rename.');
        } finally {
            // Refresh the file list
            await fetchFiles(currentPath, token);
        }
      };

      const createNewFolder = async (folderName, currentPath, token) => {
        setError(null);
        try {
            const response = await fetch('/api/folders', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    folderName: folderName,
                    currentPath: currentPath
                })
            });
            if (!response.ok) {
                throw new Error('Failed to create folder');
            }
        } catch (err) {
            setError(err.message || 'An error occurred while creating folder.');
        } finally {
            await fetchFiles(currentPath, token);
        }
      };

      const pasteFiles = async (items, operation, targetPath, token) => {
        setError(null);
        try {
            const response = await fetch('/api/files/paste', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    items: items,
                    operation: operation,
                    targetPath: targetPath
                })
            });
            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Paste operation failed');
            }
            return { success: true };
        } catch (err) {
            setError(err.message || 'An error occurred during paste.');
            return { success: false };
        } finally {
            await fetchFiles(targetPath, token);
        }
      };

      const value = {
        files,
        currentPath,
        isLoading,
        error,
        fetchFiles,
        setCurrentPath,
        searchResults,
        isSearching,
        performSearch,
        deleteFiles,
        renameFile,
        createNewFolder,
        pasteFiles,
      };  return (
    React.createElement(AppContext.Provider, { value: value }, children)
  );
};

// Exporting in a way that can be used by the existing script setup
window.AppContext = AppContext;
window.AppProvider = AppProvider;
