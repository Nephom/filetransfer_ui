package ui

import (
	"fileapi-go/api"
	"fmt"
	"io/fs"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// FileSuggestion 檔案建議元件
type FileSuggestion struct {
	IsActive      bool
	Files         []fs.DirEntry
	FilteredFiles []fs.DirEntry
	SelectedIndex int
	filter        string
	CurrentDir    string
}

// NewFileSuggestion 建立新的檔案建議元件
func NewFileSuggestion() *FileSuggestion {
	return &FileSuggestion{
		IsActive: false,
	}
}

// Activate 啟動建議（本地檔案模式）
func (s *FileSuggestion) Activate() error {
	wd, err := os.Getwd()
	if err != nil {
		return err
	}
	s.CurrentDir = wd

	files, err := os.ReadDir(wd)
	if err != nil {
		return err
	}

	s.Files = files
	s.IsActive = true
	s.filter = ""
	s.UpdateFilter("")
	return nil
}

// Deactivate 關閉建議
func (s *FileSuggestion) Deactivate() {
	s.IsActive = false
	s.filter = ""
	s.SelectedIndex = 0
}

// UpdateFilter 更新過濾器並刷新建議列表
func (s *FileSuggestion) UpdateFilter(filter string) {
	s.filter = filter
	oldFilteredCount := len(s.FilteredFiles)
	s.FilteredFiles = []fs.DirEntry{}

	for _, file := range s.Files {
		if s.filter == "" || strings.HasPrefix(file.Name(), s.filter) {
			s.FilteredFiles = append(s.FilteredFiles, file)
		}
	}

	// 只有在過濾結果數量變化時才重置選擇索引
	// 如果列表縮短且當前索引超出範圍，調整到最後一項
	if len(s.FilteredFiles) != oldFilteredCount {
		if s.SelectedIndex >= len(s.FilteredFiles) && len(s.FilteredFiles) > 0 {
			s.SelectedIndex = len(s.FilteredFiles) - 1
		} else if len(s.FilteredFiles) == 0 {
			s.SelectedIndex = 0
		}
		// 否則保持當前的 SelectedIndex
	}
}

// MoveUp 向上選擇
func (s *FileSuggestion) MoveUp() {
	if s.SelectedIndex > 0 {
		s.SelectedIndex--
	}
}

// MoveDown 向下選擇
func (s *FileSuggestion) MoveDown() {
	if s.SelectedIndex < len(s.FilteredFiles)-1 {
		s.SelectedIndex++
	}
}

// GetSelectedName 獲取當前選中的檔案名（或完整路徑）
func (s *FileSuggestion) GetSelectedName() string {
	if len(s.FilteredFiles) > 0 && s.SelectedIndex < len(s.FilteredFiles) {
		selected := s.FilteredFiles[s.SelectedIndex]

		// 如果是 FileItem（遠端檔案，包括搜尋結果），使用完整路徑
		if fileItem, ok := selected.(api.FileItem); ok {
			if fileItem.Path != "" {
				// 搜尋結果有完整路徑，直接使用
				return fileItem.Path
			}
		}

		// 否則使用檔名（本地檔案或遠端當前目錄檔案）
		name := selected.Name()
		if selected.IsDir() {
			name += "/"
		}
		return name
	}
	return ""
}

// HasFiles 檢查是否有檔案（用於決定是否顯示）
func (s *FileSuggestion) HasFiles() bool {
	return len(s.FilteredFiles) > 0
}

// Render 渲染建議列表（支援滾動視窗）
func (s *FileSuggestion) Render(width int) string {
	if !s.IsActive || !s.HasFiles() {
		return ""
	}

	var builder strings.Builder

	// 標題
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39"))
	builder.WriteString(titleStyle.Render(fmt.Sprintf("檔案建議 (%s):", s.CurrentDir)))
	builder.WriteString("\n")

	// 計算滾動視窗
	maxVisible := 8
	totalFiles := len(s.FilteredFiles)

	// 計算顯示範圍（滾動視窗）
	start := 0
	end := totalFiles

	if totalFiles > maxVisible {
		// 確保選中項在可見範圍內
		if s.SelectedIndex < maxVisible/2 {
			// 靠近開頭
			start = 0
			end = maxVisible
		} else if s.SelectedIndex >= totalFiles-maxVisible/2 {
			// 靠近結尾
			start = totalFiles - maxVisible
			end = totalFiles
		} else {
			// 居中顯示
			start = s.SelectedIndex - maxVisible/2
			end = s.SelectedIndex + maxVisible/2
			if end > totalFiles {
				end = totalFiles
			}
		}
	}

	// 顯示滾動提示
	if start > 0 {
		builder.WriteString(fmt.Sprintf("  ↑ ...還有 %d 個項目\n", start))
	}

	// 列表
	for i := start; i < end; i++ {
		file := s.FilteredFiles[i]
		icon := "📄"
		if file.IsDir() {
			icon = "📂"
		}

		line := fmt.Sprintf("%s %s", icon, file.Name())

		if i == s.SelectedIndex {
			selectedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("10")).Bold(true)
			builder.WriteString(selectedStyle.Render("▸ " + line))
		} else {
			builder.WriteString("  " + line)
		}
		builder.WriteString("\n")
	}

	// 顯示底部滾動提示
	if end < totalFiles {
		builder.WriteString(fmt.Sprintf("  ↓ ...還有 %d 個項目\n", totalFiles-end))
	}

	// 提示
	helpStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("243"))
	builder.WriteString(helpStyle.Render(fmt.Sprintf("  (↑↓ 選擇, Tab 填入, Esc 關閉) [%d/%d]", s.SelectedIndex+1, totalFiles)))

	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Padding(1).
		Width(width - 4).
		Render(builder.String())
}