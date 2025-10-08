[English](README_EN.md)

# Web-Based File Management System

一個功能完善的本地檔案管理系統，提供現代化的網頁操作介面以及強大的命令列工具。

> **🤖 AI-Generated Code Demonstration**  
> This project was developed through multiple AI-assisted iterations, showcasing collaborative development between human requirements and AI implementation. The codebase demonstrates modern web development practices, performance optimizations, and real-world problem-solving through iterative refinement.

## 核心功能 (Features)

*   **網頁操作介面**: 透過瀏覽器進行檔案的瀏覽、上傳、下載、刪除、重新命名等操作。
*   **使用者認證**: 安全的 JWT (JSON Web Token) 登入與密碼管理。
*   **高效能快取**: 使用 Redis 建立全域檔案索引快取，加速檔案列表與搜尋反應速度。
*   **強大的命令列工具**: 提供 `fileapi.sh` 腳本，可透過 command-line 進行所有檔案操作與系統管理。
*   **可配置的安全性**: 提供速率限制、安全標頭、輸入驗證等多種可選安全機制。

## 前置需求 (Prerequisites)

1.  **Node.js**: v20 或更高版本。
2.  **Redis Server**: 必須在本機中執行 Redis Server。您可以使用 Docker 快速啟動一個 Redis 實例：
    ```bash
    docker run -d --name my-redis -p 6379:6379 redis
    ```
3.  **NPM 套件**: 需要先安裝專案相依套件。

## 快速開始 (Quick Start)

1.  **安裝相依套件**:
    ```bash
    npm install
    ```

2.  **設定應用程式 (必要步驟)**:
    在使用前，您 **必須** 修改 `src/config.ini` 檔案，至少設定以下項目：
    *   `storagePath`: 檔案儲存的根目錄。
    *   `username` / `password`: 預設管理員的帳號密碼。
    ```bash
    # 建議使用您習慣的編輯器開啟並修改
    vi src/config.ini
    ```

3.  **啟動伺服器**:
    ```bash
    ./start.sh
    ```
    伺服器啟動後，會開始在背景建立檔案系統的快取。根據 `storagePath` 的檔案數量，首次啟動可能需要一些時間。

4.  **存取應用程式**:
    *   開啟瀏覽器，前往 `http://localhost:3000` (或您在 `config.ini` 中設定的埠號)。
    *   使用您設定的管理員帳號密碼登入。

## 命令列工具 (`fileapi.sh`)

本專案提供一個功能豐富的 `bash` 腳本 `fileapi.sh`，讓您可以直接從終端機管理檔案。

**顯示所有指令**:
```bash
./fileapi.sh help
```

**常用範例**:
```bash
# 登入 (會將 token 存於 .api_token)
./fileapi.sh login <your_username> <your_password>

# 列出根目錄檔案
./fileapi.sh list

# 列出指定目錄檔案
./fileapi.sh list documents/

# 上傳檔案
./fileapi.sh upload /path/to/local/file.txt (storagePATH/)documents/ # the documents folder under parameter storagePATH in config.ini

# 搜尋檔案
./fileapi.sh search "*.pdf"

# 重新整理快取
./fileapi.sh cache-refresh
```

## 重要注意事項

*   **Redis 快取與搜尋**: 本系統依賴 Redis 進行檔案索引。首次啟動或執行 `cache-refresh` 後，系統會在背景掃描並快取檔案結構。在此期間，搜尋功能可能無法回傳完整結果。您可以使用 `cache-stats` 或 `index-status` 指令來監控進度。
*   **伺服器管理**:
    *   **檢查狀態**: `./status.sh`
    *   **停止伺服器**: `./stop.sh`

## 授權 (License)

MIT License - 詳情請見 `LICENSE` 檔案。
