//go:build linux
// +build linux

package sysinfo

import (
	"fmt"
	"syscall"
)

// GetMemoryInfo 取得系統記憶體資訊（Linux 版本）
func GetMemoryInfo() (*MemoryInfo, error) {
	var info syscall.Sysinfo_t
	err := syscall.Sysinfo(&info)
	if err != nil {
		return nil, fmt.Errorf("無法取得系統資訊: %w", err)
	}

	// 計算記憶體（轉換為 bytes）
	totalRAM := info.Totalram * uint64(info.Unit)
	freeRAM := info.Freeram * uint64(info.Unit)

	// Available = Free + Buffers + Cached
	// 在 Linux 上，bufferram 包含了 buffers 和 cached
	availableRAM := freeRAM + (info.Bufferram * uint64(info.Unit))

	usedRAM := totalRAM - availableRAM
	usedPercent := float64(usedRAM) / float64(totalRAM) * 100

	// 建議的最大上傳檔案大小 = 可用記憶體的 50%
	// 這樣可以避免記憶體不足的問題
	maxUploadSize := availableRAM / 2

	return &MemoryInfo{
		TotalRAM:      totalRAM,
		FreeRAM:       freeRAM,
		AvailableRAM:  availableRAM,
		UsedPercent:   usedPercent,
		MaxUploadSize: maxUploadSize,
	}, nil
}
