package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	TokenFile  = ".api_token"
	ConfigFile = ".fileapi_config"
)

// Config 儲存應用程式配置
type Config struct {
	Host     string `json:"host"`
	Token    string `json:"token"`
	Username string `json:"username"`
}

// HostOptions 可用的主機選項
var HostOptions = []string{
	"http://192.168.1.3:9400",  // 192 LAB network
	"http://10.6.66.40:9400",   // Big network
}

// LoadConfig 從檔案載入配置
func LoadConfig() (*Config, error) {
	cfg := &Config{}

	// 讀取配置檔案
	configPath := getConfigPath(ConfigFile)
	if data, err := os.ReadFile(configPath); err == nil {
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("解析配置檔案失敗: %w", err)
		}
	}

	// 讀取 Token 檔案
	tokenPath := getConfigPath(TokenFile)
	if tokenData, err := os.ReadFile(tokenPath); err == nil {
		cfg.Token = string(tokenData)
	}

	return cfg, nil
}

// SaveConfig 儲存配置到檔案
func SaveConfig(cfg *Config) error {
	// 儲存配置檔案
	configPath := getConfigPath(ConfigFile)
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化配置失敗: %w", err)
	}

	if err := os.WriteFile(configPath, data, 0600); err != nil {
		return fmt.Errorf("寫入配置檔案失敗: %w", err)
	}

	// 儲存 Token 檔案
	if cfg.Token != "" {
		tokenPath := getConfigPath(TokenFile)
		if err := os.WriteFile(tokenPath, []byte(cfg.Token), 0600); err != nil {
			return fmt.Errorf("寫入 Token 檔案失敗: %w", err)
		}
	}

	return nil
}

// HasConfig 檢查是否存在配置
func HasConfig() bool {
	tokenPath := getConfigPath(TokenFile)
	_, err := os.Stat(tokenPath)
	return err == nil
}

// DeleteConfig 刪除配置檔案（登出使用）
func DeleteConfig() error {
	tokenPath := getConfigPath(TokenFile)
	configPath := getConfigPath(ConfigFile)

	os.Remove(tokenPath)
	os.Remove(configPath)

	return nil
}

// getConfigPath 獲取配置檔案的完整路徑
func getConfigPath(filename string) string {
	// 優先使用當前目錄
	cwd, err := os.Getwd()
	if err != nil {
		// 如果獲取失敗，使用家目錄
		home, _ := os.UserHomeDir()
		return filepath.Join(home, filename)
	}
	return filepath.Join(cwd, filename)
}
