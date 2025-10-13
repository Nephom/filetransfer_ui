package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fileapi-go/debug"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrUnauthorized Token 過期或無效錯誤
var ErrUnauthorized = errors.New("token 已過期或無效，請重新登入")

// Client API 客戶端
type Client struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// NewClient 建立新的 API 客戶端
func NewClient(baseURL, token string) *Client {
	return &Client{
		BaseURL: baseURL,
		Token:   token,
		Client: &http.Client{
			Timeout: 300 * time.Second, // 5 分鐘 timeout，適用於大檔案/資料夾上傳
		},
	}
}

// LoginRequest 登入請求
type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// LoginResponse 登入回應
type LoginResponse struct {
	Success bool   `json:"success"`
	Token   string `json:"token"`
	User    struct {
		Username string `json:"username"`
		Role     string `json:"role"`
	} `json:"user"`
}

// FileItem 檔案項目
type FileItem struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size"`
	Modified    int64  `json:"modified"`
}

// FileListResponse 檔案列表回應
type FileListResponse struct {
	Success     bool       `json:"success"`
	Files       []FileItem `json:"files"`
	CurrentPath string     `json:"currentPath"`
}

// SearchResponse 搜尋回應
type SearchResponse struct {
	Files       []FileItem `json:"files"`
	ResultCount int        `json:"resultCount"`
}

// GenericResponse 通用回應
type GenericResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Error   string `json:"error"`
}

// UploadResponse 上傳回應（單檔）
type UploadResponse struct {
	TransferID string `json:"transferId"`
}

// BatchUploadResponse 批次上傳回應（多檔）
type BatchUploadResponse struct {
	BatchID string `json:"batchId"`
}

// TransferProgress 傳輸進度
type TransferProgress struct {
	ID               string  `json:"id"`
	Status           string  `json:"status"` // pending, uploading, processing, completed, failed
	FileName         string  `json:"fileName"`
	TotalSize        int64   `json:"totalSize"`
	TransferredSize  int64   `json:"transferredSize"`
	Progress         float64 `json:"progress"`
	Error            *struct {
		Message string `json:"message"`
		Code    int    `json:"code"`
	} `json:"error"`
}

// BatchProgress 批次進度
type BatchProgress struct {
	BatchID          string         `json:"batchId"`
	Status           string         `json:"status"` // uploading, completed, partial_fail, failed
	TotalFiles       int            `json:"totalFiles"`
	SuccessCount     int            `json:"successCount"`
	FailedCount      int            `json:"failedCount"`
	PendingCount     int            `json:"pendingCount"`
	TotalSize        int64          `json:"totalSize"`
	TransferredSize  int64          `json:"transferredSize"`
	Progress         float64        `json:"progress"`
	Files            []FileProgress `json:"files"`
}

// FileProgress 檔案進度
type FileProgress struct {
	FileName string  `json:"fileName"`
	Status   string  `json:"status"`
	Progress float64 `json:"progress"`
	Error    string  `json:"error"`
}

// Login 使用者登入
func (c *Client) Login(username, password string) (*LoginResponse, error) {
	reqBody := LoginRequest{
		Username: username,
		Password: password,
	}

	data, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", c.BaseURL+"/auth/login", bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("登入請求失敗: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("登入失敗: HTTP %d", resp.StatusCode)
	}

	var loginResp LoginResponse
	if err := json.NewDecoder(resp.Body).Decode(&loginResp); err != nil {
		return nil, fmt.Errorf("解析登入回應失敗: %w", err)
	}

	// 更新客戶端 Token
	c.Token = loginResp.Token

	return &loginResp, nil
}

// ListFiles 列出檔案
func (c *Client) ListFiles(path string) (*FileListResponse, error) {
	url := c.BaseURL + "/api/files"
	if path != "" {
		url += "?path=" + path
	}
	// 添加時間戳參數強制禁用緩存
	if strings.Contains(url, "?") {
		url += fmt.Sprintf("&_t=%d", time.Now().UnixNano())
	} else {
		url += fmt.Sprintf("?_t=%d", time.Now().UnixNano())
	}

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	req.Header.Set("Pragma", "no-cache")
	req.Header.Set("Expires", "0")

	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("列表請求失敗: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, ErrUnauthorized
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("列表失敗: HTTP %d", resp.StatusCode)
	}

	var listResp FileListResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return nil, fmt.Errorf("解析列表回應失敗: %w", err)
	}

	return &listResp, nil
}

// SearchFiles 搜尋檔案
func (c *Client) SearchFiles(query string) (*SearchResponse, error) {
	reqBody := map[string]string{"query": query}
	data, _ := json.Marshal(reqBody)

	req, err := http.NewRequest("POST", c.BaseURL+"/api/files/search", bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("搜尋請求失敗: %w", err)
	}
	defer resp.Body.Close()

	var searchResp SearchResponse
	if err := json.NewDecoder(resp.Body).Decode(&searchResp); err != nil {
		return nil, fmt.Errorf("解析搜尋回應失敗: %w", err)
	}

	return &searchResp, nil
}

// UploadFile 上傳檔案（支援多檔案，帶即時進度追蹤）
func (c *Client) UploadFile(files []string, targetPath string, stats *UploadStats, progressCallback func(current, total int, message string)) error {
	debug.Log("[UploadFile] 開始上傳，檔案列表: %v", files)

	// 判斷是單檔還是多檔上傳
	isSingleFile := len(files) == 1 && !isDirectory(files[0])

	if isSingleFile {
		// 使用單檔上傳 API（帶進度追蹤）
		return c.uploadSingleFileWithProgress(files[0], targetPath, stats, progressCallback)
	} else {
		// 使用批次上傳 API（帶進度追蹤）
		return c.uploadMultipleFilesWithProgress(files, targetPath, stats, progressCallback)
	}
}

// uploadSingleFileWithProgress 單檔上傳（使用 /api/upload/single-progress）
func (c *Client) uploadSingleFileWithProgress(filePath, targetPath string, stats *UploadStats, progressCallback func(current, total int, message string)) error {
	debug.Log("[uploadSingleFileWithProgress] 開始單檔上傳: %s", filePath)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	// IMPORTANT: 依照 FileBrowser.js:387-395 的順序，path 必須在 file 之前
	// 先添加路徑
	if targetPath != "" {
		writer.WriteField("path", targetPath)
	}

	// 添加檔名
	writer.WriteField("fileName", filepath.Base(filePath))

	// 最後添加檔案
	part, err := writer.CreateFormFile("file", filepath.Base(filePath))
	if err != nil {
		debug.Log("[uploadSingleFileWithProgress] CreateFormFile 失敗: %v", err)
		return err
	}

	file, err := os.Open(filePath)
	if err != nil {
		debug.Log("[uploadSingleFileWithProgress] 開啟檔案失敗: %v", err)
		return err
	}
	defer file.Close()

	if _, err := io.Copy(part, file); err != nil {
		debug.Log("[uploadSingleFileWithProgress] 複製檔案內容失敗: %v", err)
		return err
	}

	writer.Close()

	// 發送上傳請求
	req, err := http.NewRequest("POST", c.BaseURL+"/api/upload/single-progress", body)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	debug.Log("[uploadSingleFileWithProgress] 發送請求到: %s", c.BaseURL+"/api/upload/single-progress")

	resp, err := c.Client.Do(req)
	if err != nil {
		return fmt.Errorf("上傳請求失敗: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		debug.Log("[uploadSingleFileWithProgress] 上傳失敗: HTTP %d - %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("上傳失敗: HTTP %d", resp.StatusCode)
	}

	var uploadResp UploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&uploadResp); err != nil {
		debug.Log("[uploadSingleFileWithProgress] 解析回應失敗: %v", err)
		return fmt.Errorf("解析上傳回應失敗: %w", err)
	}

	debug.Log("[uploadSingleFileWithProgress] 獲得 transferId: %s", uploadResp.TransferID)

	// 輪詢進度
	return c.pollTransferProgress(uploadResp.TransferID, progressCallback)
}

// uploadMultipleFilesWithProgress 多檔上傳（使用 /api/upload/multiple）
func (c *Client) uploadMultipleFilesWithProgress(files []string, targetPath string, stats *UploadStats, progressCallback func(current, total int, message string)) error {
	debug.Log("[uploadMultipleFilesWithProgress] 開始批次上傳，檔案數: %d", len(files))

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	// 添加所有檔案
	for _, file := range files {
		fileInfo, err := os.Stat(file)
		if err != nil {
			debug.Log("[uploadMultipleFilesWithProgress] os.Stat 失敗: %s, 錯誤: %v", file, err)
			return fmt.Errorf("無法讀取檔案 %s: %w", file, err)
		}

		if fileInfo.IsDir() {
			// 資料夾上傳：遞迴處理
			debug.Log("[uploadMultipleFilesWithProgress] 偵測到資料夾: %s", file)
			if err := c.addDirectoryToMultipart(writer, file, filepath.Base(file), stats, progressCallback); err != nil {
				debug.Log("[uploadMultipleFilesWithProgress] 資料夾處理失敗: %v", err)
				return err
			}
		} else {
			// 單檔案
			if stats != nil {
				stats.TotalFiles++
			}

			part, err := writer.CreateFormFile("files", filepath.Base(file))
			if err != nil {
				debug.Log("[uploadMultipleFilesWithProgress] CreateFormFile 失敗: %v", err)
				return err
			}

			f, err := os.Open(file)
			if err != nil {
				debug.Log("[uploadMultipleFilesWithProgress] 開啟檔案失敗: %s, 錯誤: %v", file, err)
				return err
			}
			defer f.Close()

			if _, err := io.Copy(part, f); err != nil {
				debug.Log("[uploadMultipleFilesWithProgress] 複製檔案內容失敗: %v", err)
				return err
			}
			debug.Log("[uploadMultipleFilesWithProgress] 成功添加檔案: %s", file)
		}
	}

	// 添加目標路徑
	if targetPath != "" {
		writer.WriteField("path", targetPath)
	}

	writer.Close()

	// 發送上傳請求
	req, err := http.NewRequest("POST", c.BaseURL+"/api/upload/multiple", body)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	debug.Log("[uploadMultipleFilesWithProgress] 發送請求到: %s", c.BaseURL+"/api/upload/multiple")

	resp, err := c.Client.Do(req)
	if err != nil {
		return fmt.Errorf("上傳請求失敗: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		debug.Log("[uploadMultipleFilesWithProgress] 上傳失敗: HTTP %d - %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("上傳失敗: HTTP %d", resp.StatusCode)
	}

	var batchResp BatchUploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&batchResp); err != nil {
		debug.Log("[uploadMultipleFilesWithProgress] 解析回應失敗: %v", err)
		return fmt.Errorf("解析上傳回應失敗: %w", err)
	}

	debug.Log("[uploadMultipleFilesWithProgress] 獲得 batchId: %s", batchResp.BatchID)

	// 輪詢批次進度
	return c.pollBatchProgress(batchResp.BatchID, progressCallback)
}

// UploadStats 上傳統計資訊
type UploadStats struct {
	TotalFiles int
	TotalDirs  int
}

// isDirectory 檢查路徑是否為資料夾
func isDirectory(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.IsDir()
}

// pollTransferProgress 輪詢單檔傳輸進度
func (c *Client) pollTransferProgress(transferID string, progressCallback func(current, total int, message string)) error {
	debug.Log("[pollTransferProgress] 開始輪詢 transferId: %s", transferID)

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	timeout := time.After(10 * time.Minute) // 10 分鐘超時

	for {
		select {
		case <-timeout:
			debug.Log("[pollTransferProgress] 輪詢超時")
			return fmt.Errorf("上傳超時")

		case <-ticker.C:
			// 查詢進度
			progress, err := c.GetTransferProgress(transferID)
			if err != nil {
				debug.Log("[pollTransferProgress] 查詢進度失敗: %v", err)
				return err
			}

			progressMsg := fmt.Sprintf("上傳中: %s (%.1f%%)", progress.FileName, progress.Progress)
			debug.Log("[pollTransferProgress] 進度: %.2f%%, 狀態: %s, 檔案: %s, 已傳輸: %d/%d - %s",
				progress.Progress, progress.Status, progress.FileName,
				progress.TransferredSize, progress.TotalSize, progressMsg)

			// 回調進度（這會更新UI）
			if progressCallback != nil {
				progressCallback(int(progress.TransferredSize), int(progress.TotalSize), progressMsg)
			}

			// 檢查狀態
			switch progress.Status {
			case "completed":
				debug.Log("[pollTransferProgress] 上傳完成")
				return nil
			case "failed":
				errMsg := "上傳失敗"
				if progress.Error != nil {
					errMsg = progress.Error.Message
				}
				debug.Log("[pollTransferProgress] 上傳失敗: %s", errMsg)
				return fmt.Errorf(errMsg)
			}
		}
	}
}

// pollBatchProgress 輪詢批次上傳進度
func (c *Client) pollBatchProgress(batchID string, progressCallback func(current, total int, message string)) error {
	debug.Log("[pollBatchProgress] 開始輪詢 batchId: %s", batchID)

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	timeout := time.After(10 * time.Minute) // 10 分鐘超時

	for {
		select {
		case <-timeout:
			debug.Log("[pollBatchProgress] 輪詢超時")
			return fmt.Errorf("批次上傳超時")

		case <-ticker.C:
			// 查詢進度
			batch, err := c.GetBatchProgress(batchID)
			if err != nil {
				debug.Log("[pollBatchProgress] 查詢進度失敗: %v", err)
				return err
			}

			progressMsg := fmt.Sprintf("上傳中: %d/%d 檔案完成 (%.1f%%)", batch.SuccessCount, batch.TotalFiles, batch.Progress)
			debug.Log("[pollBatchProgress] 進度: %.2f%%, 狀態: %s, 成功: %d/%d - %s",
				batch.Progress, batch.Status, batch.SuccessCount, batch.TotalFiles, progressMsg)

			// 回調進度（這會更新UI）
			if progressCallback != nil {
				progressCallback(batch.SuccessCount, batch.TotalFiles, progressMsg)
			}

			// 檢查狀態
			switch batch.Status {
			case "completed":
				debug.Log("[pollBatchProgress] 批次上傳完成")
				return nil
			case "partial_fail":
				debug.Log("[pollBatchProgress] 批次部分失敗: %d 成功, %d 失敗", batch.SuccessCount, batch.FailedCount)
				return fmt.Errorf("部分檔案上傳失敗: %d 成功, %d 失敗", batch.SuccessCount, batch.FailedCount)
			case "failed":
				debug.Log("[pollBatchProgress] 批次上傳失敗")
				return fmt.Errorf("批次上傳失敗")
			}
		}
	}
}

// GetTransferProgress 查詢單檔傳輸進度
func (c *Client) GetTransferProgress(transferID string) (*TransferProgress, error) {
	url := fmt.Sprintf("%s/api/progress/%s", c.BaseURL, transferID)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)

	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("查詢進度失敗: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("查詢進度失敗: HTTP %d", resp.StatusCode)
	}

	var progress TransferProgress
	if err := json.NewDecoder(resp.Body).Decode(&progress); err != nil {
		return nil, fmt.Errorf("解析進度回應失敗: %w", err)
	}

	return &progress, nil
}

// GetBatchProgress 查詢批次上傳進度
func (c *Client) GetBatchProgress(batchID string) (*BatchProgress, error) {
	url := fmt.Sprintf("%s/api/progress/batch/%s", c.BaseURL, batchID)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)

	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("查詢批次進度失敗: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("查詢批次進度失敗: HTTP %d", resp.StatusCode)
	}

	var batch BatchProgress
	if err := json.NewDecoder(resp.Body).Decode(&batch); err != nil {
		return nil, fmt.Errorf("解析批次進度回應失敗: %w", err)
	}

	return &batch, nil
}

// addDirectoryToMultipart 遞迴添加資料夾到 multipart
func (c *Client) addDirectoryToMultipart(writer *multipart.Writer, dirPath, basePath string, stats *UploadStats, progressCallback func(current, total int, message string)) error {
	fileIndex := 0
	debug.Log("[addDirectoryToMultipart] 開始處理資料夾: %s, 基礎路徑: %s", dirPath, basePath)

	return filepath.Walk(dirPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			debug.Log("[addDirectoryToMultipart] Walk 錯誤: %v", err)
			return nil
		}

		if info.IsDir() {
			if stats != nil {
				stats.TotalDirs++
			}
			debug.Log("[addDirectoryToMultipart] 跳過目錄: %s", path)
			return nil
		}

		relPath, _ := filepath.Rel(dirPath, path)
		// 將 Windows 路徑分隔符轉換為 Unix 風格（後端是 Linux）
		relPath = strings.ReplaceAll(relPath, "\\", "/")

		// 組合遠端路徑：使用 / 而不是 filepath.Join（避免 Windows 的 \）
		relativePath := basePath
		if relPath != "" {
			relativePath = basePath + "/" + relPath
		}

		fileIndex++
		if stats != nil {
			stats.TotalFiles++
		}

		debug.Log("[addDirectoryToMultipart] 處理檔案 #%d: %s -> %s", fileIndex, filepath.Base(path), relativePath)

		// 調用進度回調
		if progressCallback != nil {
			progressCallback(fileIndex, 0, fmt.Sprintf("正在準備: %s (%d/%d)", filepath.Base(path), fileIndex, 0))
		}

		// 創建檔案 part (使用原始檔名，不是相對路徑)
		part, err := writer.CreateFormFile("files", filepath.Base(path))
		if err != nil {
			debug.Log("[addDirectoryToMultipart] CreateFormFile 失敗: %v", err)
			return err
		}

		file, err := os.Open(path)
		if err != nil {
			debug.Log("[addDirectoryToMultipart] 開啟檔案失敗: %s, 錯誤: %v", path, err)
			return err
		}
		defer file.Close()

		_, err = io.Copy(part, file)
		if err != nil {
			debug.Log("[addDirectoryToMultipart] 複製檔案內容失敗: %v", err)
			return err
		}

		// 添加對應的 filePaths[] 欄位來保留資料夾結構
		writer.WriteField("filePaths[]", relativePath)

		debug.Log("[addDirectoryToMultipart] 成功添加檔案: %s, 相對路徑: %s", filepath.Base(path), relativePath)
		return nil
	})
}

// DownloadFile 下載單一檔案
func (c *Client) DownloadFile(remotePath, localPath string) error {
	url := c.BaseURL + "/api/files/download/" + remotePath

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)

	resp, err := c.Client.Do(req)
	if err != nil {
		return fmt.Errorf("下載請求失敗: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下載失敗: HTTP %d", resp.StatusCode)
	}

	// 建立本地檔案
	out, err := os.Create(localPath)
	if err != nil {
		return fmt.Errorf("建立本地檔案失敗: %w", err)
	}
	defer out.Close()

	// 複製內容
	_, err = io.Copy(out, resp.Body)
	return err
}

// DownloadArchive 下載多檔案打包（archive）
func (c *Client) DownloadArchive(files []string, currentPath, localPath string) error {
	type DownloadItem struct {
		Name string `json:"name"`
	}

	downloadItems := make([]DownloadItem, len(files))
	for i, file := range files {
		downloadItems[i] = DownloadItem{Name: file}
	}

	reqBody := map[string]interface{}{
		"items":       downloadItems,
		"currentPath": currentPath,
	}

	data, _ := json.Marshal(reqBody)

	req, err := http.NewRequest("POST", c.BaseURL+"/api/archive", bytes.NewBuffer(data))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Client.Do(req)
	if err != nil {
		return fmt.Errorf("打包下載請求失敗: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("打包下載失敗: HTTP %d", resp.StatusCode)
	}

	// 建立本地檔案
	out, err := os.Create(localPath)
	if err != nil {
		return fmt.Errorf("建立本地檔案失敗: %w", err)
	}
	defer out.Close()

	// 複製內容
	_, err = io.Copy(out, resp.Body)
	return err
}

// DeleteFiles 刪除檔案
func (c *Client) DeleteFiles(items []string, currentPath string) error {
	type DeleteItem struct {
		Name string `json:"name"`
	}

	deleteItems := make([]DeleteItem, len(items))
	for i, item := range items {
		deleteItems[i] = DeleteItem{Name: item}
	}

	reqBody := map[string]interface{}{
		"items":       deleteItems,
		"currentPath": currentPath,
	}

	data, _ := json.Marshal(reqBody)

	req, err := http.NewRequest("DELETE", c.BaseURL+"/api/files/delete", bytes.NewBuffer(data))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Client.Do(req)
	if err != nil {
		return fmt.Errorf("刪除請求失敗: %w", err)
	}
	defer resp.Body.Close()

	var result GenericResponse
	json.NewDecoder(resp.Body).Decode(&result)

	if !result.Success {
		return fmt.Errorf("刪除失敗: %s", result.Error)
	}

	return nil
}

// RenameFile 重命名檔案
func (c *Client) RenameFile(oldName, newName, currentPath string) error {
	reqBody := map[string]string{
		"oldName":     oldName,
		"newName":     newName,
		"currentPath": currentPath,
	}

	data, _ := json.Marshal(reqBody)

	req, err := http.NewRequest("PUT", c.BaseURL+"/api/files/rename", bytes.NewBuffer(data))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Client.Do(req)
	if err != nil {
		return fmt.Errorf("重命名請求失敗: %w", err)
	}
	defer resp.Body.Close()

	var result GenericResponse
	json.NewDecoder(resp.Body).Decode(&result)

	if !result.Success {
		return fmt.Errorf("重命名失敗: %s", result.Error)
	}

	return nil
}

// RefreshCache 刷新緩存
func (c *Client) RefreshCache(directoryPath string) error {
	reqBody := map[string]string{}
	if directoryPath != "" {
		reqBody["directoryPath"] = directoryPath
	}

	data, _ := json.Marshal(reqBody)

	req, err := http.NewRequest("POST", c.BaseURL+"/api/files/refresh-cache", bytes.NewBuffer(data))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Client.Do(req)
	if err != nil {
		return fmt.Errorf("刷新緩存請求失敗: %w", err)
	}
	defer resp.Body.Close()

	var result GenericResponse
	json.NewDecoder(resp.Body).Decode(&result)

	if !result.Success {
		return fmt.Errorf("刷新緩存失敗: %s", result.Error)
	}

	return nil
}

// MakeDirectory 建立資料夾
func (c *Client) MakeDirectory(folderName, currentPath string) error {
	reqBody := map[string]string{
		"folderName":  folderName,
		"currentPath": currentPath,
	}

	data, _ := json.Marshal(reqBody)

	req, err := http.NewRequest("POST", c.BaseURL+"/api/folders", bytes.NewBuffer(data))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Client.Do(req)
	if err != nil {
		return fmt.Errorf("建立資料夾請求失敗: %w", err)
	}
	defer resp.Body.Close()

	var result GenericResponse
	json.NewDecoder(resp.Body).Decode(&result)

	if !result.Success {
		return fmt.Errorf("建立資料夾失敗: %s", result.Error)
	}

	return nil
}

// CopyOrMoveFiles 複製或移動檔案
func (c *Client) CopyOrMoveFiles(items []string, operation, targetPath, sourcePath string) error {
	type PasteItem struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}

	pasteItems := make([]PasteItem, len(items))
	for i, item := range items {
		itemPath := sourcePath
		if sourcePath != "" {
			itemPath = sourcePath + "/" + item
		} else {
			itemPath = item
		}

		pasteItems[i] = PasteItem{
			Name: item,
			Path: itemPath,
		}
	}

	reqBody := map[string]interface{}{
		"items":      pasteItems,
		"operation":  operation, // "copy" or "cut"
		"targetPath": targetPath,
	}

	data, _ := json.Marshal(reqBody)

	req, err := http.NewRequest("POST", c.BaseURL+"/api/files/paste", bytes.NewBuffer(data))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Client.Do(req)
	if err != nil {
		return fmt.Errorf("複製/移動請求失敗: %w", err)
	}
	defer resp.Body.Close()

	var result GenericResponse
	json.NewDecoder(resp.Body).Decode(&result)

	if !result.Success {
		return fmt.Errorf("操作失敗: %s", result.Error)
	}

	return nil
}
