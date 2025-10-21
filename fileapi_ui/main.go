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
		debug.Log("[main] 載入配置失敗: %v", err)
	} else {
		debug.Log("[main] 配置載入成功 - Host: %s, Token 長度: %d, Username: %s",
			cfg.Host, len(cfg.Token), cfg.Username)
	}

	// 決定要顯示登入畫面還是主畫面
	var p *tea.Program

	for {
		debug.Log("[main] 檢查配置 - Token 長度: %d, Host: %s", len(cfg.Token), cfg.Host)

		if cfg.Token == "" || cfg.Host == "" {
			if cfg.Host == "" {
				debug.Log("[main] 未找到 host，顯示主機選擇畫面")
			} else {
				debug.Log("[main] 未找到 token，顯示登入畫面")
			}

			loginModel := ui.NewLoginModel(cfg)
			p = tea.NewProgram(loginModel, tea.WithAltScreen())

			debug.Log("[main] 開始執行登入程式")
			finalModel, err := p.Run()
			if err != nil {
				debug.Log("[main] 登入程式執行錯誤: %v", err)
				fmt.Printf("執行錯誤: %v\n", err)
				os.Exit(1)
			}

			debug.Log("[main] 登入程式結束，檢查結果")
			if login, ok := finalModel.(*ui.LoginModel); ok && login.IsComplete() {
				debug.Log("[main] 登入成功，更新配置並準備進入主畫面")
				cfg = login.GetConfig()
				debug.Log("[main] 登入後取得配置 - Token 長度: %d, Host: %s, Username: %s",
					len(cfg.Token), cfg.Host, cfg.Username)
				continue
			}

			debug.Log("[main] 登入流程未完成，結束程式")
			break
		}

		debug.Log("[main] 找到有效的 token 與 host，準備進入主畫面")
		debug.Log("[main] 進入主畫面前 - Token 長度: %d, Host: %s", len(cfg.Token), cfg.Host)

		mainModel := ui.NewMainModel(cfg)
		p = tea.NewProgram(&mainModel, tea.WithAltScreen())

		debug.Log("[main] 開始執行主畫面程式")
		if _, err := p.Run(); err != nil {
			debug.Log("[main] 主畫面執行錯誤: %v", err)
			fmt.Printf("執行錯誤: %v\n", err)
			os.Exit(1)
		}

		debug.Log("[main] 主畫面結束，檢查 token 狀態")
		debug.Log("[main] 主畫面結束後 cfg.Token 長度: %d", len(cfg.Token))
		if cfg.Token == "" {
			debug.Log("[main] 主畫面結束後偵測到 token 已清除，返回登入流程")
			continue
		}

		debug.Log("[main] 主畫面結束且 token 仍有效，結束程式")
		break
	}

	debug.Log("[main] 程式正常結束")
}