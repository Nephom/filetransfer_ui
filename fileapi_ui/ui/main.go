package ui

import (
	"fileapi-go/api"
	"fileapi-go/config"
	"fileapi-go/debug"
	"fileapi-go/parser"
	"fileapi-go/sysinfo"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const VERSION = "1.46"

// MainModel 主操作畫面模型
type MainModel struct {
	client         *api.Client
	config         *config.Config
	currentPath    string
	files          []fs.DirEntry
	input          textinput.Model
	width          int
	height         int
	scrollOffset   int // 檔案列表滾動偏移
	message        string
	messageType    string // "success", "error", "info"
	err            error
	dirSuggestion  *DirSuggestion  // 遠端目錄建議（用於 ! 指令）
	fileSuggestion *FileSuggestion // 檔案建議（用於 @ 指令）
	uploadChan     chan tea.Msg
}

// NewMainModel 建立主操作畫面
func NewMainModel(cfg *config.Config) MainModel {
	debug.Log("[NewMainModel] 創建 MainModel，Token 長度: %d, Host: %s", len(cfg.Token), cfg.Host)

	input := textinput.New()
	input.Placeholder = "輸入命令... (! 切換目錄, !! 上層, # 搜尋, @ 標記檔案)"
	input.Focus()
	input.CharLimit = 200
	input.Width = 50

	client := api.NewClient(cfg.Host, cfg.Token, cfg.SkipTLSVerify, cfg.CAPath)
	debug.Log("[NewMainModel] Client 創建完成，Client.Token 長度: %d, SkipTLSVerify: %v", len(client.Token), cfg.SkipTLSVerify)

	m := MainModel{
		client:         client,
		config:         cfg,
		currentPath:    "", // 初始化為根目錄
		input:          input,
		dirSuggestion:  NewDirSuggestion(),
		fileSuggestion: NewFileSuggestion(),
	}

	// 更新 client 的 token（確保使用最新的 token）
	m.client.Token = cfg.Token
	debug.Log("[NewMainModel] 更新後 Client.Token 長度: %d", len(m.client.Token))

	return m
}

func (m *MainModel) Init() tea.Cmd {
	return tea.Batch(
		textinput.Blink,
		m.loadFiles(m.currentPath),
	)
}

func (m *MainModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		// 處理檔案建議的快捷鍵（@ 指令）
		if m.fileSuggestion.IsActive {
			switch msg.String() {
			case "esc":
				m.fileSuggestion.Deactivate()
				return m, nil
			case "up":
				m.fileSuggestion.MoveUp()
				return m, nil
			case "down":
				m.fileSuggestion.MoveDown()
				return m, nil
			case "tab":
				// 填入選中的檔案名稱
				selected := m.fileSuggestion.GetSelectedName()
				if selected != "" {
					inputVal := m.input.Value()
					// 找到最後一個 @ 符號的位置
					lastAt := strings.LastIndex(inputVal, "@")
					if lastAt != -1 {
						// 替換 @ 後面的內容為選中的檔案名
						newValue := inputVal[:lastAt+1] + selected + " "
						m.input.SetValue(newValue)
						m.input.SetCursor(len(newValue))
						m.fileSuggestion.Deactivate()
					}
				}
				return m, nil
			}
		}

		// 處理目錄建議的快捷鍵（! 指令）
		if m.dirSuggestion.IsActive {
			switch msg.String() {
			case "esc":
				m.dirSuggestion.Deactivate()
				return m, nil
			case "up":
				m.dirSuggestion.MoveUp()
				return m, nil
			case "down":
				m.dirSuggestion.MoveDown()
				return m, nil
			case "tab", "enter":
				// 填入選中的目錄名稱，並自動加上空格
				selected := m.dirSuggestion.GetSelectedName()
				if selected != "" {
					newValue := "!" + selected + " "
					m.input.SetValue(newValue)
					m.input.SetCursor(len(newValue))
					m.dirSuggestion.Deactivate()
				}
				return m, nil
			}
		}

		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "esc":
			if m.dirSuggestion.IsActive {
				m.dirSuggestion.Deactivate()
				return m, nil
			}
			return m, tea.Quit

		case "enter":
			// 如果目錄建議活動中，填入選中的目錄
			if m.dirSuggestion.IsActive {
				selected := m.dirSuggestion.GetSelectedName()
				if selected != "" {
					m.input.SetValue("!" + selected)
					m.input.SetCursor(len(m.input.Value()))
					m.dirSuggestion.Deactivate()
					return m, nil
				}
			}
			model, cmd := m.handleCommand()
			return model, cmd

		// 滾動檔案列表
		case "ctrl+w", "up":
			if m.dirSuggestion.IsActive {
				m.dirSuggestion.MoveUp()
				return m, nil
			}
			if m.scrollOffset > 0 {
				m.scrollOffset--
			}
			return m, nil

		case "ctrl+s", "down":
			if m.dirSuggestion.IsActive {
				m.dirSuggestion.MoveDown()
				return m, nil
			}
			maxScroll := m.getMaxScroll()
			if m.scrollOffset < maxScroll {
				m.scrollOffset++
			}
			return m, nil
		case "pageup":
			m.scrollOffset -= 10
			if m.scrollOffset < 0 {
				m.scrollOffset = 0
			}
			return m, nil

		case "pagedown":
			m.scrollOffset += 10
			maxScroll := m.getMaxScroll()
			if m.scrollOffset > maxScroll {
				m.scrollOffset = maxScroll
			}
			return m, nil
		}

	case filesLoadedMsg:
		m.files = msg.files
		m.currentPath = msg.currentPath
		m.scrollOffset = 0 // 重置滾動
		return m, nil

	case commandSuccessMsg:
		m.message = string(msg)
		m.messageType = "success"
		// 立即重新載入檔案列表
		return m, m.loadFiles(m.currentPath)

	case downloadSuccessMsg:
		// 下載成功，只顯示訊息，不刷新檔案列表
		m.message = string(msg)
		m.messageType = "success"
		return m, nil

	case commandErrorMsg:
		m.message = string(msg)
		m.messageType = "error"
		return m, nil

	case reloadFilesMsg:
		// 延遲後重新載入檔案列表
		return m, m.loadFiles(m.currentPath)

	case uploadSuccessMsg:
		// 上傳成功，更新檔案列表和訊息
		debug.Log("[uploadSuccessMsg] 收到上傳成功訊息，檔案數: %d, 路徑: %s", len(msg.files), msg.path)
		debug.Log("[uploadSuccessMsg] 更新前 m.files 數量: %d", len(m.files))
		m.files = msg.files
		m.currentPath = msg.path
		m.scrollOffset = 0
		m.message = msg.message
		m.messageType = "success"
		debug.Log("[uploadSuccessMsg] 更新後 m.files 數量: %d", len(m.files))
		return m, nil

	case deleteSuccessMsg:
		// 刪除成功，更新檔案列表和訊息
		debug.Log("[deleteSuccessMsg] 收到刪除成功訊息，檔案數: %d, 路徑: %s", len(msg.files), msg.path)
		debug.Log("[deleteSuccessMsg] 更新前 m.files 數量: %d", len(m.files))
		m.files = msg.files
		m.currentPath = msg.path
		m.scrollOffset = 0
		m.message = msg.message
		m.messageType = "success"
		debug.Log("[deleteSuccessMsg] 更新後 m.files 數量: %d", len(m.files))
		return m, nil

	case uploadProgressMsg:
		// 上傳進度更新
		m.message = msg.message
		m.messageType = "info"
		// 繼續監聽下一個進度訊息
		return m, m.listenForUploads()

	case tokenExpiredMsg:
		// Token 過期，只清除記憶體中的 token，不保存到檔案
		// 這樣可以避免刪除 .api_token，讓 main.go 檢測到並重新登入
		debug.Log("[Update] Token 已過期，返回登入畫面")
		m.message = "登入已過期，請重新登入"
		m.messageType = "error"
		// 只清除記憶體中的 token，不保存（避免刪除 .api_token）
		m.config.Token = ""
		return m, tea.Quit
	}

	// 更新輸入框
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	cmds = append(cmds, cmd)

	// 如果開始輸入新命令，清除舊訊息
	if m.input.Value() != "" && m.message != "" {
		m.message = ""
		m.messageType = ""
	}

	// 偵測 ! 指令並啟動目錄建議
	inputVal := m.input.Value()
	if strings.HasPrefix(inputVal, "!") && !strings.HasPrefix(inputVal, "!!") {
		// 取得 ! 後面的部分作為過濾器
		filter := strings.TrimPrefix(inputVal, "!")

		// 如果過濾器包含空格，表示已經選好目錄了，關閉建議
		if strings.Contains(filter, " ") {
			if m.dirSuggestion.IsActive {
				m.dirSuggestion.Deactivate()
			}
		} else {
			// 啟動或更新目錄建議
			if !m.dirSuggestion.IsActive {
				m.dirSuggestion.Activate(m.files)
			}
			m.dirSuggestion.UpdateFilter(filter)
		}
	} else if m.dirSuggestion.IsActive {
		// 如果不是 ! 指令，關閉建議
		m.dirSuggestion.Deactivate()
	}

	// 偵測 @ 指令並啟動檔案建議
	if strings.Contains(inputVal, "@") {
		// 找到最後一個 @ 符號的位置
		lastAt := strings.LastIndex(inputVal, "@")
		if lastAt != -1 {
			// 取得 @ 後面的部分作為過濾器
			afterAt := inputVal[lastAt+1:]

			// 如果 @ 後面包含空格，表示已經選好檔案了，關閉建議
			if strings.Contains(afterAt, " ") {
				if m.fileSuggestion.IsActive {
					m.fileSuggestion.Deactivate()
				}
			} else {
				// 判斷命令類型：upload 顯示本地檔案，其他顯示遠端檔案
				isUpload := strings.HasPrefix(inputVal, "upload")

				// 啟動或更新檔案建議
				if !m.fileSuggestion.IsActive {
					if isUpload {
						// upload: 顯示本地檔案
						debug.Log("[@檢測] upload 命令，啟動本地檔案建議")
						if err := m.fileSuggestion.Activate(); err != nil {
							debug.Log("[@檢測] 啟動本地檔案建議失敗: %v", err)
						}
					} else {
						// 其他命令: 顯示遠端檔案（使用 m.files）
						debug.Log("[@檢測] 非 upload 命令，啟動遠端檔案建議")
						m.fileSuggestion.IsActive = true
						m.fileSuggestion.Files = m.files
					}
				}
				m.fileSuggestion.UpdateFilter(afterAt)
			}
		}
	} else if m.fileSuggestion.IsActive {
		// 如果沒有 @，關閉建議
		m.fileSuggestion.Deactivate()
	}

	return m, tea.Batch(cmds...)
}

func (m *MainModel) View() string {
	if m.width == 0 {
		return "載入中..."
	}

	// 計算各區域高度
	headerHeight := 3 // 標題列 + 邊框
	inputHeight := 3  // 輸入框（固定位置）
	statusHeight := 3 // 狀態列

	// 檢查是否有建議列表活動
	hasSuggestion := m.dirSuggestion.IsActive || m.fileSuggestion.IsActive
	suggestionHeight := 0
	if hasSuggestion {
		suggestionHeight = 12 // 預留建議列表的空間
	}

	// 檔案列表高度 = 總高度 - 其他所有固定區域
	fileListHeight := m.height - headerHeight - inputHeight - statusHeight - suggestionHeight - 2

	// 渲染檔案列表
	fileListView := m.renderFileList(fileListHeight)

	// 渲染建議列表（如果活動）
	var suggestionView string
	if m.dirSuggestion.IsActive {
		suggestionView = m.dirSuggestion.Render(m.width)
	} else if m.fileSuggestion.IsActive {
		suggestionView = m.fileSuggestion.Render(m.width)
	}

	// 渲染輸入框（固定位置）
	inputView := m.renderInput()

	// 渲染狀態列
	statusView := m.renderStatus()

	// 組合所有部分：檔案列表 → 建議列表 → 輸入框 → 狀態列
	// 這樣輸入框位置固定，建議列表出現在檔案列表和輸入框之間
	if suggestionView != "" {
		return lipgloss.JoinVertical(
			lipgloss.Left,
			fileListView,
			suggestionView,
			inputView,
			statusView,
		)
	}

	return lipgloss.JoinVertical(
		lipgloss.Left,
		fileListView,
		inputView,
		statusView,
	)
}

// renderFileList 渲染檔案列表（支援滾動和自動換行）
func (m *MainModel) renderFileList(maxHeight int) string {
	titleStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("39")).
		Padding(0, 1)

	borderStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Width(m.width - 2)

	// 標題
	pathDisplay := m.currentPath
	if pathDisplay == "" {
		pathDisplay = "/"
	}
	title := titleStyle.Render(fmt.Sprintf("📁 Current Path: %s", pathDisplay))

	// 表頭
	headerStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("243")).
		Padding(0, 1)

	header := headerStyle.Render(fmt.Sprintf("%-40s  %-12s  %-20s", "Name", "Size", "Modified"))

	// 檔案項目
	var items []string
	for _, file := range m.files {
		icon := "📄"
		if file.IsDir() {
			icon = "📂"
		}

		// 獲取文件信息
		info, err := file.Info()
		size := "-"
		modified := "-"
		if err == nil {
			if !file.IsDir() {
				size = formatSize(info.Size())
			}
			modified = formatTime(info.ModTime())
		}

		// 處理長檔名：自動換行而不是截斷
		name := file.Name()
		maxNameWidth := 38 // 給圖示留2個字元空間

		itemLine := fmt.Sprintf("%s %-38s  %-12s  %-20s", icon, truncateOrWrap(name, maxNameWidth), size, modified)
		items = append(items, itemLine)
	}

	// 應用滾動偏移
	visibleItems := items
	if len(items) > 0 {
		start := m.scrollOffset
		end := m.scrollOffset + maxHeight - 4 // 減去標題和表頭的行數

		if end > len(items) {
			end = len(items)
		}
		if start < len(items) {
			visibleItems = items[start:end]
		}
	}

	// 滾動提示
	scrollHint := ""
	if len(items) > maxHeight-4 {
		scrollHint = lipgloss.NewStyle().
			Foreground(lipgloss.Color("243")).
			Padding(0, 1).
			Render(fmt.Sprintf("(顯示 %d-%d / 共 %d 項，使用 Ctrl+W/S 或 ↑↓ 滾動)",
				m.scrollOffset+1,
				min(m.scrollOffset+len(visibleItems), len(items)),
				len(items)))
	}

	// 組合內容
	content := title + "\n" + header + "\n" + strings.Join(visibleItems, "\n")
	if scrollHint != "" {
		content += "\n" + scrollHint
	}

	// 填充空白以達到固定高度
	lines := strings.Split(content, "\n")
	for len(lines) < maxHeight {
		lines = append(lines, "")
	}
	content = strings.Join(lines[:maxHeight], "\n")

	return borderStyle.Render(content)
}

// renderInput 渲染輸入框
func (m *MainModel) renderInput() string {
	borderStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Width(m.width-2).
		Padding(0, 1)

	inputView := "> " + m.input.View()

	// 顯示訊息
	if m.message != "" {
		msgStyle := lipgloss.NewStyle()
		switch m.messageType {
		case "success":
			msgStyle = msgStyle.Foreground(lipgloss.Color("10"))
		case "error":
			msgStyle = msgStyle.Foreground(lipgloss.Color("9"))
		default:
			msgStyle = msgStyle.Foreground(lipgloss.Color("11"))
		}
		inputView += "\n" + msgStyle.Render(m.message)
	}

	return borderStyle.Render(inputView)
}

// renderStatus 渲染狀態列
func (m *MainModel) renderStatus() string {
	leftStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("243")).
		Padding(0, 1)

	rightStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("240")).
		Padding(0, 1).
		Align(lipgloss.Right)

	memStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("11")).
		Padding(0, 1)

	leftHelp := "@ 檔案  ! 切換目錄  !! 上層  # 搜尋"
	rightVersion := fmt.Sprintf("fileapi v%s", VERSION)

	// 取得系統記憶體資訊
	memInfo, err := sysinfo.GetMemoryInfo()
	var memDisplay string
	if err != nil {
		memDisplay = "記憶體資訊無法取得"
	} else {
		memDisplay = fmt.Sprintf("💾 可用記憶體: %s | 建議上傳上限: %s",
			sysinfo.FormatBytes(memInfo.AvailableRAM),
			sysinfo.FormatBytes(memInfo.MaxUploadSize))
	}

	borderStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Width(m.width - 2)

	// 組合三行狀態資訊
	// 第一行：幫助訊息 + 版本號
	leftWidth := m.width - len(rightVersion) - 10
	rightWidth := len(rightVersion) + 4
	left := leftStyle.Width(leftWidth).Render(leftHelp)
	right := rightStyle.Width(rightWidth).Render(rightVersion)
	firstLine := lipgloss.JoinHorizontal(lipgloss.Top, left, right)

	// 第二行：記憶體資訊
	memLine := memStyle.Render(memDisplay)

	// 組合兩行
	status := lipgloss.JoinVertical(lipgloss.Left, firstLine, memLine)

	return borderStyle.Render(status)
}

// handleCommand 處理命令
func (m *MainModel) handleCommand() (tea.Model, tea.Cmd) {
	cmdStr := strings.TrimSpace(m.input.Value())
	debug.Log("[handleCommand] 收到命令: '%s'", cmdStr)
	if cmdStr == "" {
		return m, nil
	}

	// 清空輸入
	m.input.SetValue("")

	// 解析命令
	cmd := parser.ParseCommand(cmdStr)
	debug.Log("[handleCommand] 解析結果 - 類型: %v, 檔案: %v, 目的地: '%s', 參數: %v", cmd.Type, cmd.Files, cmd.Destination,
		cmd.Args)

	switch cmd.Type {
	case parser.CmdNavigate:
		if len(cmd.Args) > 0 {
			// 遠端路徑拼接：統一使用 Unix 風格的 /
			newPath := cmd.Args[0]
			if m.currentPath != "" {
				newPath = m.currentPath + "/" + cmd.Args[0]
			}
			return m, m.loadFiles(newPath)
		}

	case parser.CmdUpLevel:
		if m.currentPath != "" {
			// 遠端路徑向上：手動處理，避免使用 filepath.Dir（Windows 會用 \）
			lastSlash := strings.LastIndex(m.currentPath, "/")
			parentPath := ""
			if lastSlash > 0 {
				parentPath = m.currentPath[:lastSlash]
			}
			return m, m.loadFiles(parentPath)
		}

	case parser.CmdSearch:
		if len(cmd.Args) > 0 {
			return m, m.searchFiles(cmd.Args[0])
		}

	case parser.CmdLogout:
		config.DeleteConfig()
		return m, tea.Quit

	case parser.CmdUpload:
		m.message = fmt.Sprintf("準備上傳 %d 個項目...", len(cmd.Files))
		m.messageType = "info"
		return m, m.uploadFiles(cmd)

	case parser.CmdDownload:
		return m, m.downloadFiles(cmd)

	case parser.CmdDelete:
		return m, m.deleteFiles(cmd)

	case parser.CmdRename:
		return m, m.renameFile(cmd)

	case parser.CmdCopy:
		return m, m.copyFiles(cmd)

	case parser.CmdMove:
		return m, m.moveFiles(cmd)

	case parser.CmdMkdir:
		if len(cmd.Args) > 0 {
			return m, m.makeDirectory(cmd.Args[0])
		}

	case parser.CmdHelp:
		m.message = m.getHelpMessage()
		m.messageType = "info"

	default:
		m.message = fmt.Sprintf("未知命令: %s", cmdStr)
		m.messageType = "error"
	}

	return m, nil
}

// 訊息類型
type filesLoadedMsg struct {
	files       []fs.DirEntry
	currentPath string
}

type commandSuccessMsg string
type commandErrorMsg string
type downloadSuccessMsg string // 下載成功訊息（不刷新檔案列表）
type reloadFilesMsg struct{}

type uploadSuccessMsg struct {
	message string
	files   []fs.DirEntry
	path    string
}

type deleteSuccessMsg struct {
	message string
	files   []fs.DirEntry
	path    string
}

type uploadProgressMsg struct {
	current int
	total   int
	message string
}

type tokenExpiredMsg struct{}

// listenForUploads 監聽上傳進度
func (m *MainModel) listenForUploads() tea.Cmd {
	return func() tea.Msg {
		msg, ok := <-m.uploadChan
		if !ok {
			return nil // Channel closed
		}
		return msg
	}
}

// loadFiles 載入檔案列表
func (m *MainModel) loadFiles(path string) tea.Cmd {
	return func() tea.Msg {
		// 調試：顯示正在請求的路徑
		debug.Log("[loadFiles] Requesting path: '%s'", path)
		resp, err := m.client.ListFiles(path)
		if err != nil {
			// 檢測 token 過期
			if err == api.ErrUnauthorized {
				debug.Log("[loadFiles] 偵測到 token 過期")
				return tokenExpiredMsg{}
			}
			return commandErrorMsg(fmt.Sprintf("載入失敗: %v", err))
		}
		// 調試：檢查 API 返回了多少檔案
		debug.Log("[loadFiles] API returned %d files for path: '%s'", len(resp.Files), resp.CurrentPath)
		var entries []fs.DirEntry
		for _, f := range resp.Files {
			// FileItem 已經實現了 fs.DirEntry 接口
			entries = append(entries, f)
		}
		return filesLoadedMsg{
			files:       entries,
			currentPath: resp.CurrentPath,
		}
	}
}

// searchFiles 搜尋檔案
func (m *MainModel) searchFiles(query string) tea.Cmd {
	return func() tea.Msg {
		debug.Log("[searchFiles] 開始搜尋: %s", query)
		resp, err := m.client.SearchFiles(query)
		if err != nil {
			debug.Log("[searchFiles] 搜尋失敗: %v", err)
			return commandErrorMsg(fmt.Sprintf("搜尋失敗: %v", err))
		}

		debug.Log("[searchFiles] 搜尋成功，找到 %d 個結果", len(resp.Files))

		var entries []fs.DirEntry
		for _, f := range resp.Files {
			debug.Log("[searchFiles] 檔案: %s, 大小: %d, 目錄: %v", f.FileName, f.Size, f.IsDirectory)
			entries = append(entries, f)
		}

		return filesLoadedMsg{
			files:       entries,
			currentPath: fmt.Sprintf("🔍 搜尋結果: %s (共 %d 個)", query, len(entries)),
		}
	}
}

// uploadFiles 上傳檔案（非阻塞）
func (m *MainModel) uploadFiles(cmd *parser.Command) tea.Cmd {
	m.uploadChan = make(chan tea.Msg)

	go func() {
		defer close(m.uploadChan)

		currentPath := m.currentPath
		targetPath := currentPath
		if cmd.Destination != "" && cmd.Destination != "." {
			targetPath = cmd.Destination
		}

		debug.Log("[uploadFiles] 上傳到目標路徑: %s, 當前路徑: %s", targetPath, currentPath)
		debug.Log("[uploadFiles] cmd.Files 內容: %v, 數量: %d", cmd.Files, len(cmd.Files))

		if len(cmd.Files) == 0 {
			debug.Log("[uploadFiles] cmd.Files 是空的！")
			m.uploadChan <- commandErrorMsg("上傳需要指定檔案")
			return
		}

		var absoluteFiles []string
		for _, file := range cmd.Files {
			file = strings.TrimSuffix(file, "/")
			if !filepath.IsAbs(file) {
				absPath, err := filepath.Abs(file)
				if err != nil {
					debug.Log("[uploadFiles] 轉換絕對路徑失敗: %s, 錯誤: %v", file, err)
					m.uploadChan <- commandErrorMsg(fmt.Sprintf("無法解析路徑: %s", file))
					return
				}
				file = absPath
			}
			absoluteFiles = append(absoluteFiles, file)
			debug.Log("[uploadFiles] 轉換後的絕對路徑: %s", file)
		}

		stats := &api.UploadStats{}

		progressCallback := func(current, total int, message string) {
			debug.Log("[uploadFiles] %s", message)
			var percent float64
			if total > 0 {
				percent = (float64(current) / float64(total)) * 100
			}

			// 從 "上傳中: file.zip (1.2%)" 提取檔名
			re := strings.NewReplacer("上傳中: ", "", " (", "|", "%)", "")
			parts := strings.Split(re.Replace(message), "|")
			fileName := message
			if len(parts) > 0 {
				fileName = parts[0]
			}

			progressStr := fmt.Sprintf("正在上傳: %s | 已傳輸: %d/%d | 進度: %.2f%%", fileName, current, total, percent)
			m.uploadChan <- uploadProgressMsg{message: progressStr}
		}

		debug.Log("[uploadFiles] 開始處理檔案，準備上傳到: %s", targetPath)
		err := m.client.UploadFile(absoluteFiles, targetPath, stats, progressCallback)
		if err != nil {
			debug.Log("[uploadFiles] 上傳失敗: %v", err)
			m.uploadChan <- commandErrorMsg(fmt.Sprintf("上傳失敗: %v", err))
			return
		}

		debug.Log("[uploadFiles] 上傳成功，準備刷新緩存並重新載入路徑: %s", currentPath)
		debug.Log("[uploadFiles] 上傳統計 - 檔案: %d, 目錄: %d", stats.TotalFiles, stats.TotalDirs)

		if err := m.client.RefreshCache(currentPath); err != nil {
			debug.Log("[uploadFiles] RefreshCache 失敗: %v", err)
		} else {
			debug.Log("[uploadFiles] RefreshCache 成功: %s", currentPath)
		}

		resp, err := m.client.ListFiles(currentPath)
		if err != nil {
			debug.Log("[uploadFiles] ListFiles 失敗: %v", err)
			m.uploadChan <- commandErrorMsg(fmt.Sprintf("上傳成功但重新載入失敗: %v", err))
			return
		}

		debug.Log("[uploadFiles] ListFiles 返回了 %d 個檔案, currentPath: %s", len(resp.Files), resp.CurrentPath)
		var entries []fs.DirEntry
		for _, f := range resp.Files {
			entries = append(entries, f)
		}

		successMsg := ""
		if stats.TotalDirs > 0 {
			successMsg = fmt.Sprintf("成功上傳 %d 個檔案, %d 個目錄", stats.TotalFiles, stats.TotalDirs)
		} else {
			successMsg = fmt.Sprintf("成功上傳 %d 個檔案", stats.TotalFiles)
		}

		m.uploadChan <- uploadSuccessMsg{
			message: successMsg,
			files:   entries,
			path:    resp.CurrentPath,
		}
	}()

	return m.listenForUploads()
}

// downloadFiles 下載檔案
func (m *MainModel) downloadFiles(cmd *parser.Command) tea.Cmd {
	return func() tea.Msg {
		if len(cmd.Files) == 0 {
			return commandErrorMsg("下載需要指定檔案")
		}

		isDirectory := false
		if len(cmd.Files) == 1 {
			for _, file := range m.files {
				if file.Name() == cmd.Files[0] {
					isDirectory = file.IsDir()
					break
				}
			}
		}
		useArchive := len(cmd.Files) > 1 || isDirectory || cmd.ShouldUseArchive()

		// 解析本地路徑
		localPath := cmd.Destination
		if localPath == "" || localPath == "." || localPath == "./" {
			// 預設使用當前目錄
			cwd, _ := filepath.Abs(".")
			if !useArchive {
				// 單檔：使用檔名（不是完整路徑）
				// 從遠端路徑提取檔名：Personal/Kali/em_cli.py -> em_cli.py
				fileName := filepath.Base(cmd.Files[0])
				localPath = filepath.Join(cwd, fileName)
			} else if len(cmd.Files) == 1 {
				localPath = filepath.Join(cwd, filepath.Base(cmd.Files[0])+".zip")
			} else {
				localPath = filepath.Join(cwd, "archive.zip")
			}
		} else {
			// 解析使用者指定的路徑
			absPath, err := filepath.Abs(localPath)
			if err == nil {
				localPath = absPath
			}
		}

		// A directory, even when selected alone, must use the archive endpoint.
		if !useArchive {
			// 單檔下載：使用 /api/files/download/*
			remotePath := cmd.Files[0]

			// 檢查是否已經是完整路徑（搜尋結果）
			// 搜尋結果的路徑格式：Personal/Kali/em_cli.py
			// 一般檔案的路徑格式：em_cli.py
			if !strings.Contains(remotePath, "/") && m.currentPath != "" {
				// 不包含 /，表示是當前目錄下的檔案，需要拼接 currentPath
				remotePath = m.currentPath + "/" + cmd.Files[0]
			}
			// 否則是搜尋結果的完整路徑，直接使用

			debug.Log("[downloadFiles] 最終遠端路徑: %s", remotePath)
			err := m.client.DownloadFile(remotePath, localPath)
			if err != nil {
				return commandErrorMsg(fmt.Sprintf("下載失敗: %v", err))
			}
			return downloadSuccessMsg(fmt.Sprintf("成功下載: %s", filepath.Base(localPath)))
		} else {
			// 多檔下載：使用 /api/archive
			err := m.client.DownloadArchive(cmd.Files, m.currentPath, localPath)
			if err != nil {
				return commandErrorMsg(fmt.Sprintf("打包下載失敗: %v", err))
			}
			return downloadSuccessMsg(fmt.Sprintf("成功下載 %d 個檔案至: %s", len(cmd.Files), filepath.Base(localPath)))
		}
	}
}

// deleteFiles 刪除檔案
func (m *MainModel) deleteFiles(cmd *parser.Command) tea.Cmd {
	// 捕獲當前路徑
	currentPath := m.currentPath

	return func() tea.Msg {
		// 處理搜尋結果的完整路徑問題
		// 如果檔案名包含 /，表示是搜尋結果的完整路徑，需要分離路徑和檔名
		fileNames := make([]string, len(cmd.Files))
		var actualPath string

		for i, file := range cmd.Files {
			if strings.Contains(file, "/") {
				// 搜尋結果：Tools/Nephom_tools/test.bin
				// 需要分離為 path: Tools/Nephom_tools, name: test.bin
				parts := strings.Split(file, "/")
				fileName := parts[len(parts)-1]
				dirPath := strings.Join(parts[:len(parts)-1], "/")

				fileNames[i] = fileName
				actualPath = dirPath // 使用檔案所在的實際路徑

				debug.Log("[deleteFiles] 搜尋結果檔案，完整路徑: %s, 分離為 dirPath: %s, fileName: %s",
					file, dirPath, fileName)
			} else {
				// 當前目錄檔案：test.bin
				fileNames[i] = file
				actualPath = currentPath

				debug.Log("[deleteFiles] 當前目錄檔案: %s, currentPath: %s", file, currentPath)
			}
		}

		debug.Log("[deleteFiles] 刪除檔案，使用路徑: %s, 檔案列表: %v", actualPath, fileNames)
		err := m.client.DeleteFiles(fileNames, actualPath)
		if err != nil {
			debug.Log("[deleteFiles] 刪除失敗: %v", err)
			return commandErrorMsg(fmt.Sprintf("刪除失敗: %v", err))
		}

		debug.Log("[deleteFiles] 刪除成功，準備刷新緩存並重新載入路徑: %s", currentPath)
		// 刷新當前目錄的 backend 緩存
		if err := m.client.RefreshCache(currentPath); err != nil {
			debug.Log("[deleteFiles] RefreshCache 失敗: %v", err)
			// 即使刷新失敗也繼續嘗試載入
		} else {
			debug.Log("[deleteFiles] RefreshCache 成功: %s", currentPath)
		}
		// 刪除成功後立即重新載入檔案列表
		resp, err := m.client.ListFiles(currentPath)
		if err != nil {
			debug.Log("[deleteFiles] ListFiles 失敗: %v", err)
			return commandErrorMsg(fmt.Sprintf("刪除成功但重新載入失敗: %v", err))
		}

		debug.Log("[deleteFiles] ListFiles 返回了 %d 個檔案, currentPath: %s", len(resp.Files), resp.CurrentPath)
		var entries []fs.DirEntry
		for _, f := range resp.Files {
			entries = append(entries, f)
		}
		// 返回一個組合訊息，包含成功訊息和新的檔案列表
		return deleteSuccessMsg{
			message: fmt.Sprintf("成功刪除 %d 個檔案", len(cmd.Files)),
			files:   entries,
			path:    resp.CurrentPath,
		}
	}
}

// renameFile 重命名檔案
func (m *MainModel) renameFile(cmd *parser.Command) tea.Cmd {
	// 捕獲當前路徑
	currentPath := m.currentPath

	return func() tea.Msg {
		if len(cmd.Files) == 0 || len(cmd.Args) == 0 {
			return commandErrorMsg("重命名需要舊名稱和新名稱")
		}

		oldName := cmd.Files[0]
		newName := cmd.Args[0]
		var actualPath string

		// 處理搜尋結果的完整路徑問題
		if strings.Contains(oldName, "/") {
			// 搜尋結果：Tools/Nephom_tools/test.bin
			// 需要分離為 path: Tools/Nephom_tools, name: test.bin
			parts := strings.Split(oldName, "/")
			fileName := parts[len(parts)-1]
			dirPath := strings.Join(parts[:len(parts)-1], "/")

			oldName = fileName
			actualPath = dirPath

			debug.Log("[renameFile] 搜尋結果檔案，完整路徑: %s, 分離為 dirPath: %s, fileName: %s",
				cmd.Files[0], dirPath, fileName)
		} else {
			// 當前目錄檔案
			actualPath = currentPath
			debug.Log("[renameFile] 當前目錄檔案: %s, currentPath: %s", oldName, currentPath)
		}

		debug.Log("[renameFile] 重命名，使用路徑: %s, oldName: %s, newName: %s", actualPath, oldName, newName)
		err := m.client.RenameFile(oldName, newName, actualPath)
		if err != nil {
			return commandErrorMsg(fmt.Sprintf("重命名失敗: %v", err))
		}

		// 刷新當前目錄的 backend 緩存
		if err := m.client.RefreshCache(currentPath); err != nil {
			debug.Log("[renameFile] RefreshCache 失敗: %v", err)
		} else {
			debug.Log("[renameFile] RefreshCache 成功: %s", currentPath)
		}
		// 重命名成功後立即重新載入檔案列表
		resp, err := m.client.ListFiles(currentPath)
		if err != nil {
			return commandErrorMsg(fmt.Sprintf("重命名成功但重新載入失敗: %v", err))
		}

		var entries []fs.DirEntry
		for _, f := range resp.Files {
			entries = append(entries, f)
		}

		// 返回一個組合訊息
		return deleteSuccessMsg{
			message: fmt.Sprintf("成功將 %s 重命名為 %s", oldName, newName),
			files:   entries,
			path:    resp.CurrentPath,
		}
	}
}

// copyFiles 複製檔案
func (m *MainModel) copyFiles(cmd *parser.Command) tea.Cmd {
	currentPath := m.currentPath

	return func() tea.Msg {
		if len(cmd.Files) == 0 {
			return commandErrorMsg("複製需要指定來源檔案")
		}
		if cmd.Destination == "" {
			return commandErrorMsg("複製需要指定目的地")
		}

		err := m.client.CopyOrMoveFiles(cmd.Files, "copy", cmd.Destination, currentPath)
		if err != nil {
			return commandErrorMsg(fmt.Sprintf("複製失敗: %v", err))
		}

		// 刷新當前目錄的 backend 緩存
		if err := m.client.RefreshCache(currentPath); err != nil {
			debug.Log("[copyFiles] RefreshCache 失敗: %v", err)
		} else {
			debug.Log("[copyFiles] RefreshCache 成功: %s", currentPath)
		}

		// 重新載入檔案列表
		resp, err := m.client.ListFiles(currentPath)
		if err != nil {
			return commandErrorMsg(fmt.Sprintf("複製成功但重新載入失敗: %v", err))
		}

		var entries []fs.DirEntry
		for _, f := range resp.Files {
			entries = append(entries, f)
		}

		return deleteSuccessMsg{
			message: fmt.Sprintf("成功複製 %d 個檔案", len(cmd.Files)),
			files:   entries,
			path:    resp.CurrentPath,
		}
	}
}

// moveFiles 移動檔案
func (m *MainModel) moveFiles(cmd *parser.Command) tea.Cmd {
	currentPath := m.currentPath

	return func() tea.Msg {
		if len(cmd.Files) == 0 {
			return commandErrorMsg("移動需要指定來源檔案")
		}
		if cmd.Destination == "" {
			return commandErrorMsg("移動需要指定目的地")
		}

		err := m.client.CopyOrMoveFiles(cmd.Files, "cut", cmd.Destination, currentPath)
		if err != nil {
			return commandErrorMsg(fmt.Sprintf("移動失敗: %v", err))
		}

		// 刷新當前目錄的 backend 緩存
		if err := m.client.RefreshCache(currentPath); err != nil {
			debug.Log("[moveFiles] RefreshCache 失敗: %v", err)
		} else {
			debug.Log("[moveFiles] RefreshCache 成功: %s", currentPath)
		}

		// 重新載入檔案列表
		resp, err := m.client.ListFiles(currentPath)
		if err != nil {
			return commandErrorMsg(fmt.Sprintf("移動成功但重新載入失敗: %v", err))
		}

		var entries []fs.DirEntry
		for _, f := range resp.Files {
			entries = append(entries, f)
		}

		return deleteSuccessMsg{
			message: fmt.Sprintf("成功移動 %d 個檔案", len(cmd.Files)),
			files:   entries,
			path:    resp.CurrentPath,
		}
	}
}

// makeDirectory 建立資料夾
func (m *MainModel) makeDirectory(folderName string) tea.Cmd {
	// 捕獲當前路徑
	currentPath := m.currentPath

	return func() tea.Msg {
		err := m.client.MakeDirectory(folderName, currentPath)
		if err != nil {
			return commandErrorMsg(fmt.Sprintf("建立資料夾失敗: %v", err))
		}

		// 刷新當前目錄的 backend 緩存
		if err := m.client.RefreshCache(currentPath); err != nil {
			debug.Log("[makeDirectory] RefreshCache 失敗: %v", err)
		} else {
			debug.Log("[makeDirectory] RefreshCache 成功: %s", currentPath)
		}
		// 建立成功後立即重新載入檔案列表
		resp, err := m.client.ListFiles(currentPath)
		if err != nil {
			return commandErrorMsg(fmt.Sprintf("建立資料夾成功但重新載入失敗: %v", err))
		}

		var entries []fs.DirEntry
		for _, f := range resp.Files {
			entries = append(entries, f)
		}

		// 返回一個組合訊息
		return deleteSuccessMsg{
			message: fmt.Sprintf("成功建立資料夾: %s", folderName),
			files:   entries,
			path:    resp.CurrentPath,
		}
	}
}

// 輔助函數

// getHelpMessage 獲取幫助訊息
func (m *MainModel) getHelpMessage() string {
	help := `
可用命令列表：

導航命令：
  !目錄名          - 進入指定目錄
  !!              - 返回上一層目錄
  #關鍵字          - 搜尋檔案

檔案操作：(使用 @ 標記檔案)
  upload @檔案 目的地     - 上傳檔案/資料夾
  upload @f1 @f2 ./      - 批次上傳多個檔案
  download @檔案 本地路徑  - 下載單一檔案
  download @f1 @f2 ./    - 下載多檔（自動打包）
  delete @檔案1 @檔案2    - 刪除檔案
  rename @舊名 新名       - 重新命名檔案
  copy @來源 目的地       - 複製檔案
  move @來源 目的地       - 移動檔案
  mkdir 資料夾名         - 建立資料夾

系統命令：
  ? 或 help       - 顯示此幫助訊息
  logout          - 登出系統

快捷鍵：
  Ctrl+W / ↑      - 向上滾動檔案列表
  Ctrl+S / ↓      - 向下滾動檔案列表
  PageUp/PageDown - 快速滾動
  Tab             - 在 @ 後自動完成檔案名
  Esc             - 關閉建議列表或退出
  Ctrl+C          - 退出程式
`
	return help
}

// getMaxScroll 獲取最大滾動偏移
func (m *MainModel) getMaxScroll() int {
	headerHeight := 3
	statusHeight := 3
	inputHeight := 3
	fileListHeight := m.height - headerHeight - inputHeight - statusHeight - 2
	visibleLines := fileListHeight - 4 // 減去標題和表頭

	maxScroll := len(m.files) - visibleLines
	if maxScroll < 0 {
		maxScroll = 0
	}
	return maxScroll
}

// formatSize 格式化檔案大小
func formatSize(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// formatTime 格式化時間
func formatTime(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.Format("2006-01-02 15:04")
}

// truncateOrWrap 截斷或自動換行（這裡簡化處理，只截斷）
func truncateOrWrap(s string, maxWidth int) string {
	if len(s) <= maxWidth {
		return s
	}
	return s[:maxWidth-3] + "..."
}

// min 取最小值
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
