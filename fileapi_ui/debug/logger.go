package debug

import (
	"fmt"
	"log"
	"os"
	"sync"
	"time"
)

var (
	logger      *log.Logger
	logFile     *os.File
	debugEnabled bool
	mu          sync.Mutex
)

// Init 初始化 debug logger
func Init(enabled bool) error {
	debugEnabled = enabled
	if !enabled {
		return nil
	}

	// 建立日誌檔案，檔名包含時間戳
	filename := fmt.Sprintf("fileapi-debug-%s.log", time.Now().Format("20060102-150405"))
	var err error
	logFile, err = os.OpenFile(filename, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	if err != nil {
		return err
	}

	logger = log.New(logFile, "", log.Ldate|log.Ltime|log.Lmicroseconds)
	logger.Printf("========== Debug Session Started ==========\n")

	return nil
}

// Log 輸出 debug 訊息
func Log(format string, args ...interface{}) {
	if !debugEnabled {
		return
	}

	mu.Lock()
	defer mu.Unlock()

	if logger != nil {
		logger.Printf(format, args...)
	}
}

// Close 關閉日誌檔案
func Close() {
	if logFile != nil {
		logger.Printf("========== Debug Session Ended ==========\n")
		logFile.Close()
	}
}

// IsEnabled 檢查是否啟用 debug
func IsEnabled() bool {
	return debugEnabled
}
