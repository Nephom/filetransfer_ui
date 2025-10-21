package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fileapi-go/debug"
	"fmt"
	"io"
	"io/fs"
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
	FileName    string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size"`
	Modified    int64  `json:"modified"`
}

// 實現 fs.DirEntry 接口
func (f FileItem) Name() string {
	return f.FileName
}

func (f FileItem) IsDir() bool {
	return f.IsDirectory
}

func (f FileItem) Type() fs.FileMode {
	if f.IsDirectory {
		return fs.ModeDir
	}
	return 0
}

func (f FileItem) Info() (fs.FileInfo, error) {
	return &fileItemInfo{f}, nil
}

// fileItemInfo 實現 fs.FileInfo 接口
type fileItemInfo struct {
	item FileItem
}

func (fi *fileItemInfo) Name() string {
	return fi.item.FileName
}

func (fi *fileItemInfo) Size() int64 {
	return fi.item.Size
}

func (fi *fileItemInfo) Mode() fs.FileMode {
	if fi.item.IsDirectory {
		return fs.ModeDir | 0755
	}
	return 0644
}

func (fi *fileItemInfo) ModTime() time.Time {
	return time.Unix(fi.item.Modified/1000, 0)
}

func (fi *fileItemInfo) IsDir() bool {
	return fi.item.IsDirectory
}

func (fi *fileItemInfo) Sys() interface{} {
	return nil
}

// FileListResponse 檔案列表回應
type FileListResponse struct {
	Success     bool       `json:"success"`
	Files       []FileItem `json:"files"`
	CurrentPath string     `json:"currentPath"`
}

// SearchResponseRaw 搜尋回應（原始格式，用於解析）
type SearchResponseRaw struct {
	Files       []json.RawMessage      `json:"files"` // 使用 RawMessage 來手動處理混合類型
	ResultCount int                    `json:"resultCount"`
	IndexStats  map[string]interface{} `json:"indexStats,omitempty"`
}

// SearchResponse 搜尋回應（處理後的格式）
type SearchResponse struct {
	Files       []FileItem             `json:"files"`
	ResultCount int                    `json:"resultCount"`
	IndexStats  map[string]interface{} `json:"indexStats,omitempty"`
}

// GenericResponse 通用回應
type GenericResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Error   string `json:"error"`
}

// BatchUploadResponse 批次上傳回應
type BatchUploadResponse struct {
	BatchID string `json:"batchId"`
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
	debug.Log("[ListFiles] 開始請求，path: '%s', Token 長度: %d, BaseURL: %s", path, len(c.Token), c.BaseURL)

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

	debug.Log("[ListFiles] 完整 URL: %s", url)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		debug.Log("[ListFiles] 創建請求失敗: %v", err)
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	req.Header.Set("Pragma", "no-cache")
	req.Header.Set("Expires", "0")

	debug.Log("[ListFiles] 發送請求，Authorization header: %s", req.Header.Get("Authorization")[:50]+"...")
	debug.Log("[ListFiles] Token 內容前50字元: %s", c.Token[:50])

	resp, err := c.Client.Do(req)
	if err != nil {
		debug.Log("[ListFiles] 請求失敗: %v", err)
		return nil, fmt.Errorf("列表請求失敗: %w", err)
	}
	defer resp.Body.Close()

	debug.Log("[ListFiles] 收到響應，HTTP 狀態碼: %d", resp.StatusCode)

	if resp.StatusCode == http.StatusUnauthorized {
		debug.Log("[ListFiles] 401 Unauthorized - Token 無效或過期")
		return nil, ErrUnauthorized
	}

	if resp.StatusCode != http.StatusOK {
		debug.Log("[ListFiles] 非 200 狀態碼: %d", resp.StatusCode)
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

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("搜尋失敗: HTTP %d - %s", resp.StatusCode, string(bodyBytes))
	}

	// 先讀取原始 JSON 來調試
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("讀取回應失敗: %w", err)
	}

	debug.Log("[SearchFiles] 原始回應前 500 字元: %s", string(bodyBytes[:min(500, len(bodyBytes))]))

	var rawResp SearchResponseRaw
	if err := json.Unmarshal(bodyBytes, &rawResp); err != nil {
		return nil, fmt.Errorf("解析搜尋回應失敗: %w, 原始回應: %s", err, string(bodyBytes))
	}

	// 手動解析 files 陣列，過濾掉非對象元素（如時間戳數字）
	var validFiles []FileItem
	for i, rawFile := range rawResp.Files {
		// 嘗試解析為 FileItem
		var fileItem FileItem
		if err := json.Unmarshal(rawFile, &fileItem); err != nil {
			// 如果解析失敗，可能是數字或其他類型，跳過
			debug.Log("[SearchFiles] 跳過索引 %d 的非檔案元素: %s", i, string(rawFile))
			continue
		}

		// 檢查是否有有效的檔名
		if fileItem.FileName == "" {
			debug.Log("[SearchFiles] 跳過索引 %d 的空檔名元素", i)
			continue
		}

		debug.Log("[SearchFiles] 有效檔案 %d: FileName='%s', Path='%s', IsDirectory=%v, Size=%d",
			len(validFiles), fileItem.FileName, fileItem.Path, fileItem.IsDirectory, fileItem.Size)
		validFiles = append(validFiles, fileItem)
	}

	debug.Log("[SearchFiles] 總共找到 %d 個有效檔案（過濾掉 %d 個無效元素）",
		len(validFiles), len(rawResp.Files)-len(validFiles))

	return &SearchResponse{
		Files:       validFiles,
		ResultCount: len(validFiles),
		IndexStats:  rawResp.IndexStats,
	}, nil
}

// UploadFile 上傳檔案（支援多檔案，帶即時進度追蹤）
func (c *Client) UploadFile(files []string, targetPath string, stats *UploadStats, progressCallback func(current, total int, message string)) error {
	debug.Log("[UploadFile] 開始上傳，檔案列表: %v", files)

	// 所有上傳都使用批次上傳 API（支援 streaming，不需要預先計算 Content-Length）
	// 單檔或多檔都使用同一個 endpoint，避免大檔案記憶體問題
	return c.uploadMultipleFilesWithProgress(files, targetPath, stats, progressCallback)
}

// countFiles 遞迴計算檔案總數和目錄總數
func countFiles(paths []string) (totalFiles int, totalDirs int, err error) {
	for _, path := range paths {
		info, statErr := os.Stat(path)
		if statErr != nil {
			// 如果檔案不存在，可能是個問題，但我們先忽略，讓後續的上傳邏輯處理
			debug.Log("[countFiles] os.Stat 失敗: %s, 錯誤: %v", path, statErr)
			continue
		}

		if info.IsDir() {
			// 統計目錄數 +1
			totalDirs++

			// 遍歷目錄內的檔案
			walkErr := filepath.Walk(path, func(_ string, fileInfo os.FileInfo, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				if !fileInfo.IsDir() {
					totalFiles++
				}
				return nil
			})
			if walkErr != nil {
				return 0, 0, fmt.Errorf("遍歷資料夾失敗 %s: %w", path, walkErr)
			}
		} else {
			// 單一檔案
			totalFiles++
		}
	}
	return totalFiles, totalDirs, nil
}

// uploadMultipleFilesWithProgress 多檔上傳（使用 /api/upload/multiple）
func (c *Client) uploadMultipleFilesWithProgress(files []string, targetPath string, stats *UploadStats, progressCallback func(current, total int, message string)) error {
	debug.Log("[uploadMultipleFilesWithProgress] 開始批次上傳，檔案數: %d", len(files))

	// 步驟 1: 預先計算總檔案數和目錄數
	totalFiles, totalDirs, err := countFiles(files)
	if err != nil {
		return fmt.Errorf("計算檔案總數失敗: %w", err)
	}
	debug.Log("[uploadMultipleFilesWithProgress] 總檔案數: %d, 總目錄數: %d", totalFiles, totalDirs)
	if stats != nil {
		stats.TotalFiles = totalFiles
		stats.TotalDirs = totalDirs
	}
	var filesProcessed int = 0

	// 建立管道進行真正的串流上傳
	pr, pw := io.Pipe()
	writer := multipart.NewWriter(pw)

	go func() {
		defer pw.Close()
		defer writer.Close()

		// 添加所有檔案
		for _, file := range files {
			fileInfo, err := os.Stat(file)
			if err != nil {
				pw.CloseWithError(fmt.Errorf("無法讀取檔案 %s: %w", file, err))
				return
			}

			if fileInfo.IsDir() {
				// 資料夾上傳：遞迴處理
				debug.Log("[uploadMultipleFilesWithProgress] 偵測到資料夾: %s", file)
				if err := c.addDirectoryToMultipart(writer, file, filepath.Base(file), &filesProcessed, totalFiles, progressCallback); err != nil {
					pw.CloseWithError(fmt.Errorf("資料夾處理失敗: %v", err))
					return
				}
			} else {
				// 單檔案
				filesProcessed++
				if progressCallback != nil {
					progressCallback(filesProcessed, totalFiles, fmt.Sprintf("正在準備: %s (%d/%d)", filepath.Base(file), filesProcessed, totalFiles))
				}

				part, err := writer.CreateFormFile("files", filepath.Base(file))
				if err != nil {
					pw.CloseWithError(fmt.Errorf("CreateFormFile 失敗: %w", err))
					return
				}

				f, err := os.Open(file)
				if err != nil {
					pw.CloseWithError(fmt.Errorf("開啟檔案失敗: %s, %w", file, err))
					return
				}

				if _, err := io.Copy(part, f); err != nil {
					f.Close() // copy 失敗後要手動關閉
					pw.CloseWithError(fmt.Errorf("複製檔案內容失敗: %w", err))
					return
				}
				f.Close() // 確保檔案被關閉

				// 為單一檔案添加 filePaths[]
				if err := writer.WriteField("filePaths[]", filepath.Base(file)); err != nil {
					pw.CloseWithError(fmt.Errorf("寫入 filePaths[] 欄位失敗: %w", err))
					return
				}
				debug.Log("[uploadMultipleFilesWithProgress] 成功添加檔案: %s", file)
			}
		}

		// 添加目標路徑
		if targetPath != "" {
			if err := writer.WriteField("path", targetPath); err != nil {
				pw.CloseWithError(fmt.Errorf("寫入 path 欄位失敗: %w", err))
				return
			}
		}
	}()

	// 發送上傳請求
	req, err := http.NewRequest("POST", c.BaseURL+"/api/upload/multiple", pr)
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
func (c *Client) addDirectoryToMultipart(writer *multipart.Writer, dirPath, basePath string, filesProcessed *int, totalFiles int, progressCallback func(current, total int, message string)) error {
	debug.Log("[addDirectoryToMultipart] 開始處理資料夾: %s, 基礎路徑: %s", dirPath, basePath)

	// 收集此目錄下的所有檔案路徑，以便稍後處理
	var pathsToProcess []string
	err := filepath.Walk(dirPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			pathsToProcess = append(pathsToProcess, path)
		}
		return nil
	})
	if err != nil {
		return err
	}

	for _, path := range pathsToProcess {
		// Walk 本身會處理根目錄，所以我們跳過它
		if path == dirPath {
			continue
		}

		relPath, err := filepath.Rel(dirPath, path)
		if err != nil {
			debug.Log("[addDirectoryToMultipart] Get RelPath 錯誤: %v", err)
			continue // 跳過有問題的檔案
		}
		// 將 Windows 路徑分隔符轉換為 Unix 風格（後端是 Linux）
		relPath = strings.ReplaceAll(relPath, "\\", "/")

		// 組合遠端路徑：使用 / 而不是 filepath.Join（避免 Windows 的 \）
		relativePath := basePath + "/" + relPath

		*filesProcessed++

		debug.Log("[addDirectoryToMultipart] 處理檔案 #%d: %s -> %s", *filesProcessed, filepath.Base(path), relativePath)

		// 調用進度回調
		if progressCallback != nil {
			progressCallback(*filesProcessed, totalFiles, fmt.Sprintf("正在準備: %s (%d/%d)", filepath.Base(path), *filesProcessed, totalFiles))
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

		_, copyErr := io.Copy(part, file)
		closeErr := file.Close() // 確保檔案被關閉

		if copyErr != nil {
			debug.Log("[addDirectoryToMultipart] 複製檔案內容失敗: %v", copyErr)
			return copyErr
		}
		if closeErr != nil {
			debug.Log("[addDirectoryToMultipart] 關閉檔案失敗: %v", closeErr)
			return closeErr
		}

		// 添加對應的 filePaths[] 欄位來保留資料夾結構
		if err := writer.WriteField("filePaths[]", relativePath); err != nil {
			return err
		}

		debug.Log("[addDirectoryToMultipart] 成功添加檔案: %s, 相對路徑: %s", filepath.Base(path), relativePath)
	}
	return nil
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
		var itemPath, itemName string

		// 檢查 item 是否已經包含完整路徑（搜尋結果）
		if strings.Contains(item, "/") {
			// 搜尋結果：Tools/Nephom_tools/test.bin
			// Path 應該使用完整路徑，Name 只需要檔名
			itemPath = item
			parts := strings.Split(item, "/")
			itemName = parts[len(parts)-1]

			debug.Log("[CopyOrMoveFiles] 搜尋結果檔案: %s, Name: %s, Path: %s", item, itemName, itemPath)
		} else {
			// 當前目錄檔案：test.bin
			// 需要拼接 sourcePath
			if sourcePath != "" {
				itemPath = sourcePath + "/" + item
			} else {
				itemPath = item
			}
			itemName = item

			debug.Log("[CopyOrMoveFiles] 當前目錄檔案: %s, sourcePath: %s, Name: %s, Path: %s",
				item, sourcePath, itemName, itemPath)
		}

		pasteItems[i] = PasteItem{
			Name: itemName,
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
