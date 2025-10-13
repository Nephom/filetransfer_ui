package ui

import (
	"fileapi-go/api"
	"fileapi-go/config"
	"fileapi-go/debug"
	"fileapi-go/parser"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const VERSION = "1.32"

// MainModel 主操作畫面模型
type MainModel struct {
	client         *api.Client
	config         *config.Config
	currentPath    string
	files          []api.FileItem
	input          textinput.Model
	width          int
	height         int
	scrollOffset   int // 檔案列表滾動偏移
	message        string
	messageType    string // "success", "error", "info"
	err            error
	fileSuggestion *FileSuggestion // 本地檔案建議
}

// NewMainModel 建立主操作畫面
func NewMainModel(cfg *config.Config) MainModel {
	input := textinput.New()
	input.Placeholder = "輸入命令... (! 切換目錄, !! 上層, # 搜尋, @ 標記檔案)"
	input.Focus()
	input.CharLimit = 200
	input.Width = 50

	client := api.NewClient(cfg.Host, cfg.Token)

	return MainModel{
		client:         client,
		config:         cfg,
		currentPath:    "",
		input:          input,
		files:          []api.FileItem{},
		scrollOffset:   0,
		fileSuggestion: NewFileSuggestion(),
	}
}

func (m MainModel) Init() tea.Cmd {
	return tea.Batch(
		textinput.Blink,
		m.loadFiles(""),
	)
}

func (m MainModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		// 檔案建議啟動時的特殊處理
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

			case "tab", "enter":
				// 自動填入選中的檔案
				selected := m.fileSuggestion.GetSelectedName()
				if selected != "" {
					// 獲取當前輸入，找到最後一個 @ 的位置
					currentInput := m.input.Value()
					lastAtPos := strings.LastIndex(currentInput, "@")
					if lastAtPos != -1 {
						// 找到 @ 後面的第一個空格（保留後面的參數）
						beforeAt := currentInput[:lastAtPos+1]
						afterAt := currentInput[lastAtPos+1:]

						// 找到空格位置，保留空格後面的內容（目的地參數）
						spacePos := strings.Index(afterAt, " ")
						var remaining string
						if spacePos != -1 {
							remaining = afterAt[spacePos:] // 保留空格和後面的內容
						}

						// 組合新輸入：前面 + @ + 選中檔案 + 後面保留的參數
						newInput := beforeAt + selected + remaining

						// 如果按的是 tab 且後面沒有空格，加上空格方便繼續輸入
						if msg.String() == "tab" && remaining == "" {
							newInput += " "
						}

						m.input.SetValue(newInput)

						// Issue 15: 設定游標位置到檔名後
						// 計算游標應該在的位置：@ 位置 + 1 + 檔名長度
						cursorPos := lastAtPos + 1 + len(selected)
						m.input.SetCursor(cursorPos)
					}
				}
				// Tab 填入後不關閉，Enter 填入後關閉
				// 立即關閉建議列表
				m.fileSuggestion.Deactivate()
				return m, nil
			}
		}

		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit

		case "esc":
			if m.fileSuggestion.IsActive {
				m.fileSuggestion.Deactivate()
				return m, nil
			}
			return m, tea.Quit

		// 滾動檔案列表（僅在建議未啟動時）
		case "ctrl+w", "up":
			if !m.fileSuggestion.IsActive {
				if m.scrollOffset > 0 {
					m.scrollOffset--
				}
			}
			return m, nil

		case "ctrl+s", "down":
			if !m.fileSuggestion.IsActive {
				maxScroll := m.getMaxScroll()
				if m.scrollOffset < maxScroll {
					m.scrollOffset++
				}
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

		case "enter":
			if !m.fileSuggestion.IsActive {
				return m.handleCommand()
			}
		}

	case filesLoadedMsg:
		// Issue 18: 更新檔案列表
		m.files = msg.files
		m.currentPath = msg.currentPath
		m.scrollOffset = 0 // 重置滾動
		// 添加調試訊息顯示載入的檔案數
		if m.message != "" {
			m.message += fmt.Sprintf(" (已載入 %d 個項目)", len(msg.files))
		}
		return m, nil

	case commandSuccessMsg:
		m.message = string(msg)
		m.messageType = "success"
		// 立即重新載入檔案列表
		return m, m.loadFiles(m.currentPath)

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
		return m, nil

	case tokenExpiredMsg:
		// Token 過期，清除配置並退出
		debug.Log("[Update] Token 已過期，準備清除配置並退出")
		m.message = "登入已過期，請重新登入"
		m.messageType = "error"
		// 清除 token
		m.config.Token = ""
		config.SaveConfig(m.config)
		// 延遲一下讓使用者看到訊息
		return m, tea.Sequence(
			func() tea.Msg {
				return nil
			},
			tea.Quit,
		)
	}

	// 更新輸入框
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)

	// 如果開始輸入新命令，清除舊訊息
	if m.input.Value() != "" && m.message != "" {
		debug.Log("[Update] 清除舊訊息")
		m.message = ""
		m.messageType = ""
	}

	// 檢測 @ 符號觸發檔案建議
	// Issue 19: 支援多個 @ 符號，找游標前最近的 @
	inputValue := m.input.Value()
	cursorPos := m.input.Position()
	debug.Log("[Update] 輸入值: '%s', 游標位置: %d", inputValue, cursorPos)

	// 找到游標前最近的 @ 位置
	lastAtPos := -1
	for i := cursorPos - 1; i >= 0; i-- {
		if i < len(inputValue) && inputValue[i] == '@' {
			lastAtPos = i
			break
		}
	}
	debug.Log("[Update] 找到的 @ 位置: %d", lastAtPos)

	// 判斷游標前的 @ 後面是否還在輸入（沒有空格 = 還在輸入檔名）
	isTypingAfterAt := false
	if lastAtPos != -1 && lastAtPos < len(inputValue) {
		afterAt := ""
		if lastAtPos+1 < cursorPos && cursorPos <= len(inputValue) {
			afterAt = inputValue[lastAtPos+1:cursorPos]
		}
		// 如果 @ 後面到游標之間沒有空格，表示還在輸入檔名
		// 包括剛輸入 @ 的情況（afterAt 為空字串）
		if !strings.Contains(afterAt, " ") {
			isTypingAfterAt = true
		}
		debug.Log("[Update] @ 後面的內容: '%s', 是否在輸入: %v", afterAt, isTypingAfterAt)
	}

	if lastAtPos != -1 && isTypingAfterAt && !m.fileSuggestion.IsActive {
		// 只在 @ 後面還在輸入時才啟動建議
		// 判斷是upload命令（用本地檔案）還是其他命令（用遠端檔案）
		isUploadCommand := strings.HasPrefix(strings.TrimSpace(inputValue), "upload")
		debug.Log("[Update] 偵測到 @ 符號，isUploadCommand: %v", isUploadCommand)

		if isUploadCommand {
			// upload: 使用本地檔案列表
			debug.Log("[Update] 偵測到 upload @ 觸發，準備啟動本地檔案建議")
			debug.Log("[Update] 當前工作目錄: %s", m.fileSuggestion.CurrentDir)
			if err := m.fileSuggestion.Activate(); err != nil {
				debug.Log("[Update] 啟動本地檔案建議失敗: %v", err)
			} else {
				debug.Log("[Update] 本地檔案建議已啟動，檔案數: %d", len(m.fileSuggestion.Files))
			}
		} else {
			// 其他命令: 使用遠端檔案列表
			debug.Log("[Update] 偵測到 @ 觸發（非upload），準備啟動遠端檔案建議")
			m.fileSuggestion.ActivateRemote(m.files, m.currentPath)
			debug.Log("[Update] 遠端檔案建議已啟動，檔案數: %d", len(m.fileSuggestion.Files))
		}

		// 提取 @ 後面的過濾字串
		if lastAtPos != -1 && lastAtPos+1 < len(inputValue) {
			filter := inputValue[lastAtPos+1:]
			// 移除後面的空格或其他符號，只保留檔名部分
			if spacePos := strings.Index(filter, " "); spacePos != -1 {
				filter = filter[:spacePos]
			}
			debug.Log("[Update] 更新過濾器: '%s'", filter)
			m.fileSuggestion.UpdateFilter(filter)
		}
	} else if !strings.Contains(inputValue, "@") && m.fileSuggestion.IsActive {
		// 輸入中沒有 @，關閉建議
		debug.Log("[Update] 輸入中沒有 @，關閉建議")
		m.fileSuggestion.Deactivate()
	} else if m.fileSuggestion.IsActive && isTypingAfterAt {
		// 只在還在 @ 後面輸入時才更新過濾器
		if lastAtPos != -1 && lastAtPos+1 < len(inputValue) {
			filter := ""
			if lastAtPos < len(inputValue)-1 {
				filter = inputValue[lastAtPos+1:]
				if spacePos := strings.Index(filter, " "); spacePos != -1 {
					filter = filter[:spacePos]
				}
			}
			debug.Log("[Update] 建議已啟動，更新過濾器: '%s'", filter)
			m.fileSuggestion.UpdateFilter(filter)
		}
	} else if m.fileSuggestion.IsActive && !isTypingAfterAt {
		// @ 後面已經有空格了，關閉建議
		debug.Log("[Update] @ 後面有空格，關閉建議")
		m.fileSuggestion.Deactivate()
	}

	return m, cmd
}

func (m MainModel) View() string {
	if m.width == 0 {
		return "載入中..."
	}

	// 計算各區域高度
	headerHeight := 3      // 標題列 + 邊框
	statusHeight := 3      // 狀態列

	// 動態計算 inputHeight：當建議列表顯示時需要更多空間
	inputHeight := 3       // 基本輸入框高度
	if m.fileSuggestion.IsActive && m.fileSuggestion.HasFiles() {
		// 建議標題 + 最多8個檔案 + 提示行 + padding
		suggestionLines := 1 + min(8, len(m.fileSuggestion.FilteredFiles)) + 1
		if len(m.fileSuggestion.FilteredFiles) > 8 {
			suggestionLines++ // "... 還有 N 個檔案"
		}
		inputHeight += suggestionLines
	}

	fileListHeight := m.height - headerHeight - inputHeight - statusHeight - 2

	// 渲染檔案列表
	fileListView := m.renderFileList(fileListHeight)

	// 渲染輸入框
	inputView := m.renderInput()

	// 渲染狀態列
	statusView := m.renderStatus()

	// 組合所有部分
	return lipgloss.JoinVertical(
		lipgloss.Left,
		fileListView,
		inputView,
		statusView,
	)
}

// renderFileList 渲染檔案列表（支援滾動和自動換行）
func (m MainModel) renderFileList(maxHeight int) string {
	debug.Log("[renderFileList] 渲染檔案列表，m.files 數量: %d, currentPath: %s", len(m.files), m.currentPath)
	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("39")).
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
		if file.IsDirectory {
			icon = "📂"
		}

		size := formatSize(file.Size)
		if file.IsDirectory {
			size = "-"
		}

		modified := formatTime(file.Modified)

		// 處理長檔名：自動換行而不是截斷
		name := file.Name
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
func (m MainModel) renderInput() string {
	borderStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Width(m.width - 2).
		Padding(0, 1)

	inputView := "> " + m.input.View()

	// 顯示檔案建議
	if m.fileSuggestion.IsActive && m.fileSuggestion.HasFiles() {
		suggestionStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("243")).
			MarginTop(1)

		titleStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("39")).
			Bold(true)

		selectedStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("10")).
			Bold(true)

		normalStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("243"))

		// 顯示標題：本地檔案或遠端檔案
		titleText := ""
		if m.fileSuggestion.IsLocalMode {
			titleText = fmt.Sprintf("本地檔案 (%s):", m.fileSuggestion.CurrentDir)
		} else {
			titleText = fmt.Sprintf("遠端檔案 (%s):", m.fileSuggestion.CurrentDir)
		}
		inputView += "\n" + titleStyle.Render(titleText)

		// 滾動顯示建議列表
		maxShow := 8
		totalFiles := len(m.fileSuggestion.FilteredFiles)
		selectedIdx := m.fileSuggestion.SelectedIndex

		// 計算滾動窗口：讓選中項目始終可見
		startIdx := 0
		if totalFiles > maxShow {
			// 如果選中項目在下半部，滾動列表
			if selectedIdx >= maxShow-2 {
				startIdx = selectedIdx - maxShow + 3
				if startIdx + maxShow > totalFiles {
					startIdx = totalFiles - maxShow
				}
			}
		}

		endIdx := startIdx + maxShow
		if endIdx > totalFiles {
			endIdx = totalFiles
		}

		visibleFiles := m.fileSuggestion.FilteredFiles[startIdx:endIdx]

		for i, file := range visibleFiles {
			icon := "📄"
			if file.IsDirectory {
				icon = "📂"
			}

			actualIdx := startIdx + i
			prefix := "  "
			style := normalStyle
			if actualIdx == selectedIdx {
				prefix = "▸ "
				style = selectedStyle
			}

			line := fmt.Sprintf("%s%s %s", prefix, icon, file.Name)
			inputView += "\n" + style.Render(line)
		}

		// 顯示滾動提示
		if totalFiles > maxShow {
			scrollInfo := fmt.Sprintf("  (%d-%d / 共 %d 個檔案)", startIdx+1, endIdx, totalFiles)
			inputView += "\n" + suggestionStyle.Render(scrollInfo)
		}

		inputView += "\n" + suggestionStyle.Render("  (↑↓ 選擇, Tab/Enter 填入, Esc 關閉)")
	} else if m.message != "" {
		// 顯示訊息（當沒有建議時）
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
func (m MainModel) renderStatus() string {
	leftStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("243")).
		Padding(0, 1)

	rightStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("243")).
		Padding(0, 1).
		Align(lipgloss.Right)

	leftHelp := "@ 檔案  ! 切換目錄  !! 上層  # 搜尋"
	rightVersion := fmt.Sprintf("fileapi-go v%s", VERSION)

	borderStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Width(m.width - 2)

	// 計算左右寬度
	leftWidth := m.width - len(rightVersion) - 10
	rightWidth := len(rightVersion) + 4

	left := leftStyle.Width(leftWidth).Render(leftHelp)
	right := rightStyle.Width(rightWidth).Render(rightVersion)

	status := lipgloss.JoinHorizontal(lipgloss.Top, left, right)

	return borderStyle.Render(status)
}

// handleCommand 處理命令
func (m MainModel) handleCommand() (tea.Model, tea.Cmd) {
	cmdStr := strings.TrimSpace(m.input.Value())
	debug.Log("[handleCommand] 收到命令: '%s'", cmdStr)
	if cmdStr == "" {
		return m, nil
	}

	// 清空輸入
	m.input.SetValue("")

	// 解析命令
	cmd := parser.ParseCommand(cmdStr)
	debug.Log("[handleCommand] 解析結果 - 類型: %v, 檔案: %v, 目的地: '%s', 參數: %v", cmd.Type, cmd.Files, cmd.Destination, cmd.Args)

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
		// 顯示上傳中訊息（注意：進度會在 debug log 中顯示）
		if m.fileSuggestion != nil {
			m.fileSuggestion.LocalDir = ""
		}
		m.message = fmt.Sprintf("正在上傳 %d 個項目...", len(cmd.Files))
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
	files       []api.FileItem
	currentPath string
}

type commandSuccessMsg string
type commandErrorMsg string
type reloadFilesMsg struct{}

type uploadSuccessMsg struct {
	message string
	files   []api.FileItem
	path    string
}

type deleteSuccessMsg struct {
	message string
	files   []api.FileItem
	path    string
}

type uploadProgressMsg struct {
	current int
	total   int
	message string
}

type tokenExpiredMsg struct{}

// loadFiles 載入檔案列表
func (m MainModel) loadFiles(path string) tea.Cmd {
	return func() tea.Msg {
		// 調試：顯示正在請求的路徑
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
		return filesLoadedMsg{
			files:       resp.Files,
			currentPath: resp.CurrentPath,
		}
	}
}

// searchFiles 搜尋檔案
func (m MainModel) searchFiles(query string) tea.Cmd {
	return func() tea.Msg {
		resp, err := m.client.SearchFiles(query)
		if err != nil {
			return commandErrorMsg(fmt.Sprintf("搜尋失敗: %v", err))
		}
		return filesLoadedMsg{
			files:       resp.Files,
			currentPath: fmt.Sprintf("搜尋結果: %s", query),
		}
	}
}

// uploadFiles 上傳檔案
func (m MainModel) uploadFiles(cmd *parser.Command) tea.Cmd {
	// 捕獲當前路徑
	currentPath := m.currentPath

	return func() tea.Msg {
		targetPath := currentPath
		if cmd.Destination != "" && cmd.Destination != "." {
			targetPath = cmd.Destination
		}

		debug.Log("[uploadFiles] 上傳到目標路徑: %s, 當前路徑: %s", targetPath, currentPath)
		debug.Log("[uploadFiles] cmd.Files 內容: %v, 數量: %d", cmd.Files, len(cmd.Files))

		if len(cmd.Files) == 0 {
			debug.Log("[uploadFiles] cmd.Files 是空的！")
			return commandErrorMsg("上傳需要指定檔案")
		}

		// 將相對路徑轉換為絕對路徑
		var absoluteFiles []string
		for _, file := range cmd.Files {
			// 移除尾隨的 / (資料夾建議會加上)
			file = strings.TrimSuffix(file, "/")

			// 如果是相對路徑，轉換為絕對路徑
			if !filepath.IsAbs(file) {
				absPath, err := filepath.Abs(file)
				if err != nil {
					debug.Log("[uploadFiles] 轉換絕對路徑失敗: %s, 錯誤: %v", file, err)
					return commandErrorMsg(fmt.Sprintf("無法解析路徑: %s", file))
				}
				file = absPath
			}
			absoluteFiles = append(absoluteFiles, file)
			debug.Log("[uploadFiles] 轉換後的絕對路徑: %s", file)
		}

		// 建立上傳統計
		stats := &api.UploadStats{
			TotalFiles: 0,
			TotalDirs:  0,
		}

		// 建立進度回調函數
		progressCallback := func(current, total int, message string) {
			// 記錄每個檔案的處理進度到 debug log
			debug.Log("[uploadFiles] %s", message)
		}

		// 顯示開始訊息
		debug.Log("[uploadFiles] 開始處理檔案，準備上傳到: %s", targetPath)

		err := m.client.UploadFile(absoluteFiles, targetPath, stats, progressCallback)
		if err != nil {
			debug.Log("[uploadFiles] 上傳失敗: %v", err)
			return commandErrorMsg(fmt.Sprintf("上傳失敗: %v", err))
		}

		debug.Log("[uploadFiles] 上傳成功，準備刷新緩存並重新載入路徑: %s", currentPath)
		debug.Log("[uploadFiles] 上傳統計 - 檔案: %d, 目錄: %d", stats.TotalFiles, stats.TotalDirs)

		// 刷新當前目錄的 backend 緩存
		if err := m.client.RefreshCache(currentPath); err != nil {
			debug.Log("[uploadFiles] RefreshCache 失敗: %v", err)
			// 即使刷新失敗也繼續嘗試載入
		} else {
			debug.Log("[uploadFiles] RefreshCache 成功: %s", currentPath)
		}
		// 上傳成功後重新載入當前目錄的檔案列表
		resp, err := m.client.ListFiles(currentPath)
		if err != nil {
			debug.Log("[uploadFiles] ListFiles 失敗: %v", err)
			return commandErrorMsg(fmt.Sprintf("上傳成功但重新載入失敗: %v", err))
		}

		debug.Log("[uploadFiles] ListFiles 返回了 %d 個檔案, currentPath: %s", len(resp.Files), resp.CurrentPath)
		// 返回一個組合訊息，包含成功訊息和新的檔案列表
		// 格式：成功上傳 X 個檔案, Y 個目錄
		successMsg := ""
		if stats.TotalDirs > 0 {
			successMsg = fmt.Sprintf("成功上傳 %d 個檔案, %d 個目錄", stats.TotalFiles, stats.TotalDirs)
		} else {
			successMsg = fmt.Sprintf("成功上傳 %d 個檔案", stats.TotalFiles)
		}

		return uploadSuccessMsg{
			message: successMsg,
			files:   resp.Files,
			path:    resp.CurrentPath,
		}
	}
}

// downloadFiles 下載檔案
func (m MainModel) downloadFiles(cmd *parser.Command) tea.Cmd {
	return func() tea.Msg {
		if len(cmd.Files) == 0 {
			return commandErrorMsg("下載需要指定檔案")
		}

		// 解析本地路徑
		localPath := cmd.Destination
		if localPath == "" || localPath == "." || localPath == "./" {
			// 預設使用當前目錄
			cwd, _ := filepath.Abs(".")
			if len(cmd.Files) == 1 {
				// 單檔：使用檔名
				localPath = filepath.Join(cwd, cmd.Files[0])
			} else {
				// 多檔：預設 archive.zip
				localPath = filepath.Join(cwd, "archive.zip")
			}
		} else {
			// 解析使用者指定的路徑
			absPath, err := filepath.Abs(localPath)
			if err == nil {
				localPath = absPath
			}
		}

		// 單檔下載 vs 多檔打包下載
		if len(cmd.Files) == 1 {
			// 單檔下載：使用 /api/files/download/*
			// 組合完整的遠端路徑: currentPath + fileName
			remotePath := cmd.Files[0]
			if m.currentPath != "" {
				remotePath = m.currentPath + "/" + cmd.Files[0]
			}
			err := m.client.DownloadFile(remotePath, localPath)
			if err != nil {
				return commandErrorMsg(fmt.Sprintf("下載失敗: %v", err))
			}
			return commandSuccessMsg(fmt.Sprintf("成功下載: %s", filepath.Base(localPath)))
		} else {
			// 多檔下載：使用 /api/archive
			err := m.client.DownloadArchive(cmd.Files, m.currentPath, localPath)
			if err != nil {
				return commandErrorMsg(fmt.Sprintf("打包下載失敗: %v", err))
			}
			return commandSuccessMsg(fmt.Sprintf("成功下載 %d 個檔案至: %s", len(cmd.Files), filepath.Base(localPath)))
		}
	}
}

// deleteFiles 刪除檔案
func (m MainModel) deleteFiles(cmd *parser.Command) tea.Cmd {
	// 捕獲當前路徑
	currentPath := m.currentPath

	return func() tea.Msg {
		debug.Log("[deleteFiles] 刪除檔案，當前路徑: %s", currentPath)
		err := m.client.DeleteFiles(cmd.Files, currentPath)
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
		// 返回一個組合訊息，包含成功訊息和新的檔案列表
		return deleteSuccessMsg{
			message: fmt.Sprintf("成功刪除 %d 個檔案", len(cmd.Files)),
			files:   resp.Files,
			path:    resp.CurrentPath,
		}
	}
}

// renameFile 重命名檔案
func (m MainModel) renameFile(cmd *parser.Command) tea.Cmd {
	// 捕獲當前路徑
	currentPath := m.currentPath

	return func() tea.Msg {
		if len(cmd.Files) == 0 || len(cmd.Args) == 0 {
			return commandErrorMsg("重命名需要舊名稱和新名稱")
		}
		oldName := cmd.Files[0]
		newName := cmd.Args[0]
		err := m.client.RenameFile(oldName, newName, currentPath)
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

		// 返回一個組合訊息
		return deleteSuccessMsg{
			message: fmt.Sprintf("成功將 %s 重命名為 %s", oldName, newName),
			files:   resp.Files,
			path:    resp.CurrentPath,
		}
	}
}

// copyFiles 複製檔案
func (m MainModel) copyFiles(cmd *parser.Command) tea.Cmd {
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

		return deleteSuccessMsg{
			message: fmt.Sprintf("成功複製 %d 個檔案", len(cmd.Files)),
			files:   resp.Files,
			path:    resp.CurrentPath,
		}
	}
}

// moveFiles 移動檔案
func (m MainModel) moveFiles(cmd *parser.Command) tea.Cmd {
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

		return deleteSuccessMsg{
			message: fmt.Sprintf("成功移動 %d 個檔案", len(cmd.Files)),
			files:   resp.Files,
			path:    resp.CurrentPath,
		}
	}
}

// makeDirectory 建立資料夾
func (m MainModel) makeDirectory(folderName string) tea.Cmd {
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

		// 返回一個組合訊息
		return deleteSuccessMsg{
			message: fmt.Sprintf("成功建立資料夾: %s", folderName),
			files:   resp.Files,
			path:    resp.CurrentPath,
		}
	}
}

// 輔助函數

// getHelpMessage 獲取幫助訊息
func (m MainModel) getHelpMessage() string {
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
func (m MainModel) getMaxScroll() int {
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
func formatTime(timestamp int64) string {
	if timestamp == 0 {
		return "-"
	}
	t := time.Unix(timestamp/1000, 0)
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
