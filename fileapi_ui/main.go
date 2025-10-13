package main

import (
	"fileapi-go/config"
	"fileapi-go/debug"
	"fileapi-go/ui"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	// 檢查是否啟用 debug 模式
	debugEnabled := false
	for _, arg := range os.Args[1:] {
		if arg == "-debug" || arg == "-d" {
			debugEnabled = true
			break
		}
	}

	// 初始化 debug logger
	if err := debug.Init(debugEnabled); err != nil {
		fmt.Printf("初始化 debug logger 失敗: %v\n", err)
	}
	defer debug.Close()

	debug.Log("========== FileAPI 啟動 ==========")

	// 載入配置
	cfg, err := config.LoadConfig()
	if err != nil {
		debug.Log("載入配置失敗: %v", err)
	}

	// 決定要顯示登入畫面還是主畫面
	var p *tea.Program
	if cfg.Token == "" {
		debug.Log("未找到 token，顯示登入畫面")
		loginModel := ui.NewLoginModel(cfg)
		p = tea.NewProgram(loginModel, tea.WithAltScreen())

		debug.Log("開始執行登入程式")
		finalModel, err := p.Run()
		if err != nil {
			debug.Log("登入程式執行錯誤: %v", err)
			fmt.Printf("執行錯誤: %v\n", err)
			os.Exit(1)
		}

		// 檢查登入是否完成
		if login, ok := finalModel.(ui.LoginModel); ok && login.IsComplete() {
			debug.Log("登入成功，準備切換到主畫面")
			cfg = login.GetConfig()

			// 建立主畫面並執行
			mainModel := ui.NewMainModel(cfg)
			debug.Log("成功建立主畫面")
			p = tea.NewProgram(mainModel, tea.WithAltScreen())

			debug.Log("開始執行主畫面程式")
			if _, err := p.Run(); err != nil {
				debug.Log("主畫面執行錯誤: %v", err)
				fmt.Printf("執行錯誤: %v\n", err)
				os.Exit(1)
			}
		}
	} else {
		debug.Log("找到 token，嘗試進入主畫面")
		mainModel := ui.NewMainModel(cfg)
		debug.Log("成功建立主畫面")
		p = tea.NewProgram(mainModel, tea.WithAltScreen())

		debug.Log("開始執行主畫面程式")
		if _, err := p.Run(); err != nil {
			debug.Log("主畫面執行錯誤: %v", err)
			fmt.Printf("執行錯誤: %v\n", err)
			os.Exit(1)
		}
	}
	debug.Log("程式正常結束")
}
