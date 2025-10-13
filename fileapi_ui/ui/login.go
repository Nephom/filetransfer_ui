package ui

import (
	"fmt"
	"fileapi-go/api"
	"fileapi-go/config"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// LoginState 登入狀態
type LoginState int

const (
	StateHostSelect LoginState = iota
	StateUsername
	StatePassword
	StateLoggingIn
	StateComplete
)

// LoginModel 登入畫面模型
type LoginModel struct {
	state       LoginState
	hostIndex   int
	username    textinput.Model
	password    textinput.Model
	err         error
	config      *config.Config
	loginResult *api.LoginResponse
	width       int
	height      int
}

// NewLoginModel 建立登入畫面
func NewLoginModel(cfg *config.Config) LoginModel {
	username := textinput.New()
	username.Placeholder = "請輸入使用者名稱"
	username.CharLimit = 50
	username.Width = 40

	password := textinput.New()
	password.Placeholder = "請輸入密碼"
	password.CharLimit = 50
	password.Width = 40
	password.EchoMode = textinput.EchoPassword
	password.EchoCharacter = '•'

	state := StateHostSelect
	if cfg.Host != "" {
		state = StateUsername
		username.Focus()
	}

	return LoginModel{
		state:     state,
		hostIndex: 0,
		username:  username,
		password:  password,
		config:    cfg,
	}
}

func (m LoginModel) Init() tea.Cmd {
	return textinput.Blink
}

func (m LoginModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			return m, tea.Quit

		case "enter":
			return m.handleEnter()

		case "up":
			if m.state == StateHostSelect && m.hostIndex > 0 {
				m.hostIndex--
			}
		case "down":
			if m.state == StateHostSelect && m.hostIndex < len(config.HostOptions)-1 {
				m.hostIndex++
			}
		}

	case loginCompleteMsg:
		m.state = StateComplete
		m.loginResult = msg.response
		return m, tea.Quit
	case loginErrorMsg:
		m.state = StateUsername
		m.err = msg.err
		m.username.Focus()
		return m, nil
	}

	// 更新輸入框
	var cmd tea.Cmd
	if m.state == StateUsername {
		m.username, cmd = m.username.Update(msg)
	} else if m.state == StatePassword {
		m.password, cmd = m.password.Update(msg)
	}

	return m, cmd
}

func (m LoginModel) View() string {
	if m.width == 0 {
		return "載入中..."
	}

	var content string

	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("39")).
		MarginBottom(1)

	boxStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("39")).
		Padding(1, 2).
		Width(60)

	errorStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("196")).
		MarginTop(1)

	switch m.state {
	case StateHostSelect:
		title := titleStyle.Render("選擇 API 伺服器")
		options := ""
		for i, host := range config.HostOptions {
			prefix := "  "
			if i == m.hostIndex {
				prefix = "▸ "
			}
			network := "(192 LAB network)"
			if i == 1 {
				network = "(Big network)"
			}
			options += fmt.Sprintf("%s%s %s\n", prefix, host, network)
		}
		hint := "\n使用 ↑↓ 選擇，Enter 確認"
		content = boxStyle.Render(title + "\n\n" + options + hint)

	case StateUsername:
		title := titleStyle.Render(fmt.Sprintf("登入到: %s", m.config.Host))
		content = boxStyle.Render(title + "\n\n使用者名稱:\n" + m.username.View() + "\n\n按 Enter 繼續")
		if m.err != nil {
			content += "\n" + errorStyle.Render("✗ "+m.err.Error())
		}

	case StatePassword:
		title := titleStyle.Render(fmt.Sprintf("登入到: %s", m.config.Host))
		content = boxStyle.Render(title + "\n\n使用者: " + m.username.Value() + "\n\n密碼:\n" + m.password.View() + "\n\n按 Enter 登入")

	case StateLoggingIn:
		title := titleStyle.Render("登入中...")
		content = boxStyle.Render(title + "\n\n請稍候...")

	case StateComplete:
		title := titleStyle.Render("✓ 登入成功")
		username := m.loginResult.User.Username
		role := m.loginResult.User.Role
		content = boxStyle.Render(fmt.Sprintf("%s\n\n歡迎, %s (%s)", title, username, role))
	}

	// 置中顯示
	return lipgloss.Place(
		m.width,
		m.height,
		lipgloss.Center,
		lipgloss.Center,
		content,
	)
}

func (m LoginModel) handleEnter() (tea.Model, tea.Cmd) {
	switch m.state {
	case StateHostSelect:
		m.config.Host = config.HostOptions[m.hostIndex]
		m.state = StateUsername
		m.username.Focus()
		return m, nil

	case StateUsername:
		if m.username.Value() == "" {
			return m, nil
		}
		m.state = StatePassword
		m.username.Blur()
		m.password.Focus()
		return m, nil

	case StatePassword:
		if m.password.Value() == "" {
			return m, nil
		}
		m.state = StateLoggingIn
		m.password.Blur()
		m.config.Username = m.username.Value()
		return m, m.performLogin()
	}

	return m, nil
}

// 登入訊息類型
type loginCompleteMsg struct {
	response *api.LoginResponse
}

type loginErrorMsg struct {
	err error
}

func (m LoginModel) performLogin() tea.Cmd {
	return func() tea.Msg {
		client := api.NewClient(m.config.Host, "")
		resp, err := client.Login(m.username.Value(), m.password.Value())
		if err != nil {
			return loginErrorMsg{err: err}
		}

		// 儲存配置
		m.config.Token = resp.Token
		config.SaveConfig(m.config)

		return loginCompleteMsg{response: resp}
	}
}

// GetConfig 獲取配置
func (m LoginModel) GetConfig() *config.Config {
	return m.config
}

// IsComplete 檢查是否完成
func (m LoginModel) IsComplete() bool {
	return m.state == StateComplete
}
