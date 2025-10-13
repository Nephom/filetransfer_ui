package ui

import (
	"fileapi-go/api"
	"os"
	"path/filepath"
	"strings"
)

// LocalFile 本地檔案項目
type LocalFile struct {
	Name        string
	Path        string
	IsDirectory bool
	Size        int64
}

// ScanLocalDirectory 掃描本地目錄
func ScanLocalDirectory(dirPath string) ([]LocalFile, error) {
	if dirPath == "" || dirPath == "." {
		var err error
		dirPath, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}

	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}

	var files []LocalFile
	for _, entry := range entries {
		// 跳過隱藏檔案
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		fullPath := filepath.Join(dirPath, entry.Name())

		files = append(files, LocalFile{
			Name:        entry.Name(),
			Path:        fullPath,
			IsDirectory: entry.IsDir(),
			Size:        info.Size(),
		})
	}

	return files, nil
}

// FilterFiles 根據輸入過濾檔案
func FilterFiles(files []LocalFile, filter string) []LocalFile {
	if filter == "" {
		return files
	}

	filter = strings.ToLower(filter)
	var filtered []LocalFile

	for _, file := range files {
		if strings.Contains(strings.ToLower(file.Name), filter) {
			filtered = append(filtered, file)
		}
	}

	return filtered
}

// FileSuggestion 檔案建議狀態
type FileSuggestion struct {
	Files          []LocalFile
	FilteredFiles  []LocalFile
	SelectedIndex  int
	Filter         string
	IsActive       bool
	CurrentDir     string
	IsLocalMode    bool // true: 本地檔案, false: 遠端檔案
}

// NewFileSuggestion 建立檔案建議
func NewFileSuggestion() *FileSuggestion {
	cwd, _ := os.Getwd()
	return &FileSuggestion{
		Files:         []LocalFile{},
		FilteredFiles: []LocalFile{},
		SelectedIndex: 0,
		Filter:        "",
		IsActive:      false,
		CurrentDir:    cwd,
		IsLocalMode:   true,
	}
}

// Activate 啟動檔案建議（本地模式）
func (fs *FileSuggestion) Activate() error {
	files, err := ScanLocalDirectory(fs.CurrentDir)
	if err != nil {
		return err
	}

	fs.Files = files
	fs.FilteredFiles = files
	fs.SelectedIndex = 0
	fs.IsActive = true
	fs.Filter = ""
	fs.IsLocalMode = true

	// 注意：這裡不能使用 debug.Log，因為會造成 import cycle
	// debug.Log("[FileSuggestion.Activate] 本地模式啟動，目錄: %s, 檔案數: %d", fs.CurrentDir, len(files))

	return nil
}

// ActivateRemote 啟動檔案建議（遠端模式）
func (fs *FileSuggestion) ActivateRemote(remoteFiles []api.FileItem, remotePath string) {
	// 將遠端檔案轉換為 LocalFile 格式
	var files []LocalFile
	for _, file := range remoteFiles {
		files = append(files, LocalFile{
			Name:        file.Name,
			Path:        file.Name, // 遠端檔案只用名稱
			IsDirectory: file.IsDirectory,
			Size:        file.Size,
		})
	}

	fs.Files = files
	fs.FilteredFiles = files
	fs.SelectedIndex = 0
	fs.IsActive = true
	fs.Filter = ""
	fs.IsLocalMode = false
	fs.CurrentDir = remotePath
}

// Deactivate 停用檔案建議
func (fs *FileSuggestion) Deactivate() {
	fs.IsActive = false
	fs.SelectedIndex = 0
	fs.Filter = ""
}

// UpdateFilter 更新過濾條件
func (fs *FileSuggestion) UpdateFilter(filter string) {
	// 只在過濾條件改變時才更新
	if fs.Filter == filter {
		return
	}

	fs.Filter = filter
	oldSelected := fs.SelectedIndex
	fs.FilteredFiles = FilterFiles(fs.Files, filter)

	// 保持選擇在有效範圍內，不要總是跳回第一項
	if oldSelected < len(fs.FilteredFiles) {
		fs.SelectedIndex = oldSelected
	} else if len(fs.FilteredFiles) > 0 {
		fs.SelectedIndex = len(fs.FilteredFiles) - 1
	} else {
		fs.SelectedIndex = 0
	}
}

// MoveUp 向上移動選擇
func (fs *FileSuggestion) MoveUp() {
	if fs.SelectedIndex > 0 {
		fs.SelectedIndex--
	}
}

// MoveDown 向下移動選擇
func (fs *FileSuggestion) MoveDown() {
	if fs.SelectedIndex < len(fs.FilteredFiles)-1 {
		fs.SelectedIndex++
	}
}

// GetSelected 獲取選中的檔案
func (fs *FileSuggestion) GetSelected() *LocalFile {
	if fs.SelectedIndex >= 0 && fs.SelectedIndex < len(fs.FilteredFiles) {
		return &fs.FilteredFiles[fs.SelectedIndex]
	}
	return nil
}

// GetSelectedName 獲取選中的檔案名稱（用於自動填入）
func (fs *FileSuggestion) GetSelectedName() string {
	file := fs.GetSelected()
	if file == nil {
		return ""
	}

	name := file.Name

	// 如果檔名包含空格，自動加上引號
	if strings.Contains(name, " ") {
		name = "\"" + name + "\""
	}

	// 如果是資料夾，加上 /（在引號內）
	if file.IsDirectory {
		if strings.Contains(name, " ") {
			// 已經有引號了，在引號內加 /
			name = strings.TrimSuffix(name, "\"") + "/\""
		} else {
			name = name + "/"
		}
	}

	return name
}

// HasFiles 是否有檔案
func (fs *FileSuggestion) HasFiles() bool {
	return len(fs.FilteredFiles) > 0
}
