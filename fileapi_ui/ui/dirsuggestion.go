package ui

import (
	"fmt"
	"io/fs"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// DirSuggestion 遠端目錄建議元件（用於 ! 指令）
type DirSuggestion struct {
	IsActive      bool
	Dirs          []fs.DirEntry // 遠端目錄列表
	FilteredDirs  []fs.DirEntry
	SelectedIndex int
	filter        string
}

// NewDirSuggestion 建立新的目錄建議元件
func NewDirSuggestion() *DirSuggestion {
	return &DirSuggestion{
		IsActive: false,
	}
}

// Activate 啟動建議（遠端目錄模式）
func (s *DirSuggestion) Activate(files []fs.DirEntry) {
	s.IsActive = true
	s.Dirs = []fs.DirEntry{}

	// 只保留目錄
	for _, file := range files {
		if file.IsDir() {
			s.Dirs = append(s.Dirs, file)
		}
	}

	s.filter = ""
	s.UpdateFilter("")
}

// Deactivate 關閉建議
func (s *DirSuggestion) Deactivate() {
	s.IsActive = false
	s.filter = ""
	s.SelectedIndex = 0
}

// UpdateFilter 更新過濾器並刷新建議列表（不區分大小寫）
func (s *DirSuggestion) UpdateFilter(filter string) {
	s.filter = filter
	oldFilteredCount := len(s.FilteredDirs)
	s.FilteredDirs = []fs.DirEntry{}

	// 小寫化過濾器用於不區分大小寫比對
	filterLower := strings.ToLower(filter)

	for _, dir := range s.Dirs {
		dirNameLower := strings.ToLower(dir.Name())
		// 不區分大小寫的前綴匹配
		if filter == "" || strings.HasPrefix(dirNameLower, filterLower) {
			s.FilteredDirs = append(s.FilteredDirs, dir)
		}
	}

	// 只有在過濾結果數量變化時才重置選擇索引
	// 如果列表縮短且當前索引超出範圍，調整到最後一項
	if len(s.FilteredDirs) != oldFilteredCount {
		if s.SelectedIndex >= len(s.FilteredDirs) && len(s.FilteredDirs) > 0 {
			s.SelectedIndex = len(s.FilteredDirs) - 1
		} else if len(s.FilteredDirs) == 0 {
			s.SelectedIndex = 0
		}
		// 否則保持當前的 SelectedIndex
	}
}

// MoveUp 向上選擇
func (s *DirSuggestion) MoveUp() {
	if s.SelectedIndex > 0 {
		s.SelectedIndex--
	}
}

// MoveDown 向下選擇
func (s *DirSuggestion) MoveDown() {
	if s.SelectedIndex < len(s.FilteredDirs)-1 {
		s.SelectedIndex++
	}
}

// GetSelectedName 獲取當前選中的目錄名
func (s *DirSuggestion) GetSelectedName() string {
	if len(s.FilteredDirs) > 0 && s.SelectedIndex < len(s.FilteredDirs) {
		return s.FilteredDirs[s.SelectedIndex].Name()
	}
	return ""
}

// HasDirs 檢查是否有目錄（用於決定是否顯示）
func (s *DirSuggestion) HasDirs() bool {
	return len(s.FilteredDirs) > 0
}

// Render 渲染建議列表（支援滾動視窗）
func (s *DirSuggestion) Render(width int) string {
	if !s.IsActive || !s.HasDirs() {
		return ""
	}

	var builder strings.Builder

	// 標題
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39"))
	builder.WriteString(titleStyle.Render("目錄建議 (遠端目錄):"))
	builder.WriteString("\n")

	// 計算滾動視窗
	maxVisible := 8
	totalDirs := len(s.FilteredDirs)

	// 計算顯示範圍（滾動視窗）
	start := 0
	end := totalDirs

	if totalDirs > maxVisible {
		// 確保選中項在可見範圍內
		if s.SelectedIndex < maxVisible/2 {
			// 靠近開頭
			start = 0
			end = maxVisible
		} else if s.SelectedIndex >= totalDirs-maxVisible/2 {
			// 靠近結尾
			start = totalDirs - maxVisible
			end = totalDirs
		} else {
			// 居中顯示
			start = s.SelectedIndex - maxVisible/2
			end = s.SelectedIndex + maxVisible/2
			if end > totalDirs {
				end = totalDirs
			}
		}
	}

	// 顯示滾動提示
	if start > 0 {
		builder.WriteString(fmt.Sprintf("  ↑ ...還有 %d 個目錄\n", start))
	}

	// 列表
	for i := start; i < end; i++ {
		dir := s.FilteredDirs[i]
		icon := "📂"
		line := fmt.Sprintf("%s %s", icon, dir.Name())

		if i == s.SelectedIndex {
			selectedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("10")).Bold(true)
			builder.WriteString(selectedStyle.Render("▸ " + line))
		} else {
			builder.WriteString("  " + line)
		}
		builder.WriteString("\n")
	}

	// 顯示底部滾動提示
	if end < totalDirs {
		builder.WriteString(fmt.Sprintf("  ↓ ...還有 %d 個目錄\n", totalDirs-end))
	}

	// 提示
	helpStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("243"))
	builder.WriteString(helpStyle.Render(fmt.Sprintf("  (↑↓ 選擇, Tab/Enter 填入, Esc 關閉) [%d/%d]", s.SelectedIndex+1, totalDirs)))

	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Padding(1).
		Width(width - 4).
		Render(builder.String())
}
