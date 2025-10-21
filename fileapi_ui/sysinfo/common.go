package sysinfo

import (
	"fmt"
	"runtime"
)

// MemoryInfo 記憶體資訊
type MemoryInfo struct {
	TotalRAM      uint64  // 總記憶體 (bytes)
	FreeRAM       uint64  // 可用記憶體 (bytes)
	AvailableRAM  uint64  // 實際可用記憶體 (bytes，考慮 cache)
	UsedPercent   float64
	MaxUploadSize uint64  // 建議的最大上傳檔案大小 (bytes)
}

// FormatBytes 格式化 bytes 為人類可讀格式
func FormatBytes(bytes uint64) string {
	const (
		KB = 1024
		MB = KB * 1024
		GB = MB * 1024
	)

	switch {
	case bytes >= GB:
		return fmt.Sprintf("%.2f GB", float64(bytes)/float64(GB))
	case bytes >= MB:
		return fmt.Sprintf("%.2f MB", float64(bytes)/float64(MB))
	case bytes >= KB:
		return fmt.Sprintf("%.2f KB", float64(bytes)/float64(KB))
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}

// GetGoMemoryStats 取得 Go runtime 記憶體統計
func GetGoMemoryStats() string {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return fmt.Sprintf("Go Heap: %s / %s",
		FormatBytes(m.Alloc),
		FormatBytes(m.Sys))
}
