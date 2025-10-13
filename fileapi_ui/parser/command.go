package parser

import (
	"path/filepath"
	"strings"
)

// CommandType 命令類型
type CommandType string

const (
	CmdNavigate CommandType = "navigate" // !目錄
	CmdUpLevel  CommandType = "uplevel"  // !!
	CmdSearch   CommandType = "search"   // #關鍵字
	CmdUpload   CommandType = "upload"   // upload @file...
	CmdDownload CommandType = "download" // download @file...
	CmdDelete   CommandType = "delete"   // delete @file...
	CmdRename   CommandType = "rename"   // rename @old new
	CmdCopy     CommandType = "copy"     // copy @src dest
	CmdMove     CommandType = "move"     // move @src dest
	CmdMkdir    CommandType = "mkdir"    // mkdir name
	CmdLogout   CommandType = "logout"   // logout
	CmdHelp     CommandType = "help"     // ?
	CmdUnknown  CommandType = "unknown"
)

// Command 解析後的命令
type Command struct {
	Type        CommandType
	Args        []string
	Files       []string // @ 標記的檔案列表
	Destination string   // 目的地路徑
}

// ParseCommand 解析使用者輸入的命令
func ParseCommand(input string) *Command {
	input = strings.TrimSpace(input)
	if input == "" {
		return &Command{Type: CmdUnknown}
	}

	// 處理特殊符號開頭的命令
	if input == "?" || input == "help" {
		return &Command{Type: CmdHelp}
	}

	if strings.HasPrefix(input, "!!") {
		return &Command{Type: CmdUpLevel}
	}

	if strings.HasPrefix(input, "!") {
		dirName := strings.TrimPrefix(input, "!")
		dirName = strings.TrimSpace(dirName)
		// 將 Windows 路徑分隔符轉換為 Unix 風格（遠端是 Linux）
		dirName = strings.ReplaceAll(dirName, "\\", "/")
		return &Command{
			Type: CmdNavigate,
			Args: []string{dirName},
		}
	}

	if strings.HasPrefix(input, "#") {
		query := strings.TrimPrefix(input, "#")
		return &Command{
			Type: CmdSearch,
			Args: []string{strings.TrimSpace(query)},
		}
	}

	// 分割命令和參數
	parts := smartSplit(input)
	if len(parts) == 0 {
		return &Command{Type: CmdUnknown}
	}

	cmdName := strings.ToLower(parts[0])
	args := parts[1:]

	switch cmdName {
	case "upload":
		return parseFileCommand(CmdUpload, args)
	case "download":
		return parseFileCommand(CmdDownload, args)
	case "delete", "del", "rm":
		return parseFileCommand(CmdDelete, args)
	case "rename", "mv":
		return parseRenameCommand(args)
	case "copy", "cp":
		return parseFileCommand(CmdCopy, args)
	case "move":
		return parseFileCommand(CmdMove, args)
	case "mkdir":
		return &Command{
			Type: CmdMkdir,
			Args: args,
		}
	case "logout", "exit", "quit":
		return &Command{Type: CmdLogout}
	default:
		return &Command{Type: CmdUnknown, Args: parts}
	}
}

// parseFileCommand 解析檔案操作命令（upload, download, delete, copy, move）
func parseFileCommand(cmdType CommandType, args []string) *Command {
	cmd := &Command{
		Type:  cmdType,
		Files: []string{},
	}

	for i, arg := range args {
		if strings.HasPrefix(arg, "@") {
			// 去除 @ 符號並添加到檔案列表
			file := strings.TrimPrefix(arg, "@")
			if file != "" {
				cmd.Files = append(cmd.Files, file)
			}
		} else {
			// 最後一個非 @ 參數視為目的地
			if i == len(args)-1 {
				// download 命令的目的地是本地路徑，使用 filepath.Clean
				// 其他命令的目的地是遠端路徑，使用 resolvePath（轉換為 Unix 格式）
				if cmdType == CmdDownload {
					cmd.Destination = filepath.Clean(arg)
				} else {
					cmd.Destination = resolvePath(arg)
				}
			} else {
				// 其他參數添加到 Args
				cmd.Args = append(cmd.Args, arg)
			}
		}
	}

	return cmd
}

// parseRenameCommand 解析重命名命令
func parseRenameCommand(args []string) *Command {
	cmd := &Command{
		Type: CmdRename,
	}

	var oldName, newName string

	for _, arg := range args {
		if strings.HasPrefix(arg, "@") {
			oldName = strings.TrimPrefix(arg, "@")
		} else if oldName != "" && newName == "" {
			newName = arg
		}
	}

	if oldName != "" && newName != "" {
		cmd.Files = []string{oldName}
		cmd.Args = []string{newName}
	}

	return cmd
}

// smartSplit 智能分割命令，處理引號內的空格
func smartSplit(input string) []string {
	var result []string
	var current strings.Builder
	inQuotes := false
	quoteChar := rune(0)

	for _, r := range input {
		switch r {
		case '"', '\'':
			if !inQuotes {
				inQuotes = true
				quoteChar = r
			} else if r == quoteChar {
				inQuotes = false
				quoteChar = 0
			} else {
				current.WriteRune(r)
			}
		case ' ', '\t':
			if inQuotes {
				current.WriteRune(r)
			} else if current.Len() > 0 {
				result = append(result, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}

	if current.Len() > 0 {
		result = append(result, current.String())
	}

	return result
}

// resolvePath 解析路徑（處理 ./ 和絕對路徑）
// 注意：這用於遠端路徑（下載目的地除外），統一使用 Unix 風格的 /
func resolvePath(path string) string {
	if path == "./" || path == "." {
		return "."
	}

	// 將 Windows 路徑分隔符轉換為 Unix 風格（遠端是 Linux）
	path = strings.ReplaceAll(path, "\\", "/")

	// 簡單清理：移除多餘的斜線
	for strings.Contains(path, "//") {
		path = strings.ReplaceAll(path, "//", "/")
	}

	return path
}

// GetFileCount 獲取檔案數量
func (c *Command) GetFileCount() int {
	return len(c.Files)
}

// HasFiles 檢查是否有檔案
func (c *Command) HasFiles() bool {
	return len(c.Files) > 0
}

// GetFirstFile 獲取第一個檔案
func (c *Command) GetFirstFile() string {
	if len(c.Files) > 0 {
		return c.Files[0]
	}
	return ""
}

// IsMultiFile 是否為多檔案操作
func (c *Command) IsMultiFile() bool {
	return len(c.Files) > 1
}

// ShouldUseArchive 是否應該使用打包下載（download 命令專用）
func (c *Command) ShouldUseArchive() bool {
	if c.Type != CmdDownload {
		return false
	}

	// 多個檔案或資料夾需要打包
	if c.IsMultiFile() {
		return true
	}

	// 檢查第一個檔案是否為資料夾（以 / 結尾）
	if c.HasFiles() {
		firstFile := c.GetFirstFile()
		return strings.HasSuffix(firstFile, "/")
	}

	return false
}
