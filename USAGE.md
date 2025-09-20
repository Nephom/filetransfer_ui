# 檔案傳輸系統 - 使用說明

## 🚀 快速開始

### 啟動服務
```bash
./start.sh
```

### 停止服務
```bash
./stop.sh
```

### 檢查狀態
```bash
./status.sh
```

## 📋 腳本功能說明

### start.sh - 啟動腳本
**功能**：
- ✅ 檢查 Node.js 環境
- ✅ 檢查服務器文件是否存在
- ✅ 檢查端口是否被占用
- ✅ 創建必要目錄（storage, logs）
- ✅ 後台啟動服務器
- ✅ 保存進程 PID
- ✅ 驗證啟動狀態
- ✅ 顯示訪問信息

**輸出信息**：
- 🏠 本地訪問地址
- 🌍 網絡訪問地址
- 🔐 登入帳號密碼
- 📝 日誌文件位置
- 🆔 進程 ID

### stop.sh - 停止腳本
**功能**：
- ✅ 查找運行中的服務進程
- ✅ 優雅停止服務（SIGTERM）
- ✅ 強制停止（如果需要）
- ✅ 清理 PID 文件
- ✅ 顯示最後的日誌記錄

**安全特性**：
- 🔍 智能進程檢測
- ⏳ 等待優雅停止
- 💪 強制停止備用方案
- 🧹 自動清理

### status.sh - 狀態檢查腳本
**功能**：
- 📊 服務運行狀態
- 🔍 進程詳細信息
- 🌐 端口監聽狀態
- 📝 日誌文件信息
- ⚙️ 配置文件檢查
- 📁 存儲目錄統計
- 💡 操作建議

## 🔧 配置說明

### 默認配置
- **端口**：3000
- **用戶名**：admin
- **密碼**：password
- **存儲路徑**：./storage

### 修改配置
編輯 `src/config.ini` 文件：
```ini
[server]
port=3000

[auth]
username=admin
password=password

[fileSystem]
storagePath=./storage
```

## 📁 文件結構

### 運行時文件
```
filetransfer_ui/
├── start.sh           # 啟動腳本
├── stop.sh            # 停止腳本
├── status.sh          # 狀態檢查腳本
├── server.pid         # 進程 ID 文件（運行時）
├── server.log         # 服務器日誌文件
└── storage/           # 檔案存儲目錄
```

### 日誌文件
- **位置**：`server.log`
- **內容**：服務器啟動信息、錯誤日誌、訪問記錄
- **查看**：`tail -f server.log`

## 🌐 訪問應用程式

### 啟動後訪問
1. 執行 `./start.sh`
2. 等待啟動完成
3. 打開瀏覽器訪問：http://localhost:3000
4. 使用帳號：admin / password

### 網絡訪問
- 同一網絡內的其他設備可以通過顯示的網絡 IP 訪問
- 例如：http://192.168.1.100:3000

## 🛠️ 故障排除

### 常見問題

**1. 端口被占用**
```bash
# 查看占用端口的進程
lsof -i :3000

# 停止占用進程
kill -9 <PID>
```

**2. 服務無法啟動**
```bash
# 檢查日誌
cat server.log

# 檢查 Node.js 版本
node --version
```

**3. 無法訪問網頁**
```bash
# 檢查服務狀態
./status.sh

# 檢查防火牆設置
# macOS: 系統偏好設置 > 安全性與隱私 > 防火牆
# Linux: ufw status
```

**4. 權限問題**
```bash
# 確保腳本有執行權限
chmod +x start.sh stop.sh status.sh

# 確保存儲目錄可寫
chmod 755 storage/
```

### 重置服務
```bash
# 停止服務
./stop.sh

# 清理日誌（可選）
rm -f server.log

# 重新啟動
./start.sh
```

## 🔐 安全建議

### 開發環境
- ✅ 使用默認配置即可
- ✅ 所有安全功能已關閉以便開發

### 生產環境
1. **修改默認密碼**
   ```ini
   [auth]
   username=your_username
   password=your_strong_password
   ```

2. **啟用安全功能**
   ```ini
   [security]
   enableRateLimit=true
   enableSecurityHeaders=true
   enableInputValidation=true
   ```

3. **設置 HTTPS**
   - 配置反向代理（Nginx/Apache）
   - 使用 SSL 證書

4. **限制網絡訪問**
   - 配置防火牆規則
   - 使用 VPN 或內網訪問

## 📞 支援

### 日誌查看
```bash
# 實時查看日誌
tail -f server.log

# 查看最近 50 行日誌
tail -n 50 server.log

# 搜索錯誤日誌
grep -i error server.log
```

### 系統信息
```bash
# 檢查系統資源
./status.sh

# 檢查 Node.js 版本
node --version

# 檢查可用端口
netstat -an | grep LISTEN
```

---

**版本**：v1.0
**最後更新**：2025-09-20
**兼容性**：macOS, Linux
