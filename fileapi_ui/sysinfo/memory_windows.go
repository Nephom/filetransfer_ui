//go:build windows
// +build windows

package sysinfo

import (
	"fmt"
	"syscall"
	"unsafe"
)

// MEMORYSTATUSEX Windows 記憶體狀態結構
type MEMORYSTATUSEX struct {
	dwLength                uint32
	dwMemoryLoad            uint32
	ullTotalPhys            uint64
	ullAvailPhys            uint64
	ullTotalPageFile        uint64
	ullAvailPageFile        uint64
	ullTotalVirtual         uint64
	ullAvailVirtual         uint64
	ullAvailExtendedVirtual uint64
}

// GetMemoryInfo 取得系統記憶體資訊（Windows 版本）
func GetMemoryInfo() (*MemoryInfo, error) {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	globalMemoryStatusEx := kernel32.NewProc("GlobalMemoryStatusEx")

	var memStatus MEMORYSTATUSEX
	memStatus.dwLength = uint32(unsafe.Sizeof(memStatus))

	ret, _, err := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&memStatus)))
	if ret == 0 {
		return nil, fmt.Errorf("無法取得系統記憶體資訊: %w", err)
	}

	totalRAM := memStatus.ullTotalPhys
	availableRAM := memStatus.ullAvailPhys
	freeRAM := availableRAM // Windows 的 AvailPhys 已經考慮了 cache

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
