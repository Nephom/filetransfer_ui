[English](README_EN.md)

# Web-Based File Management System 3.2.0-pre.0

提供檔案總管式網頁介面與 Ubuntu 桌面客戶端的本地檔案管理系統。Windows 使用者透過瀏覽器使用網頁介面；Tauri 桌面客戶端僅發行 Ubuntu DEB。

## 功能

- 瀏覽器檔案總管：瀏覽、上傳、下載、重新命名、刪除、分享與資料夾 ZIP 下載。
- JWT 驗證、TLS 管理、可設定的安全功能與檔案快取。
- Ubuntu 22.04+ Tauri DEB：滑鼠導向的檔案總管桌面客戶端。
- `build.sh`：安裝、首次設定、更新、測試與 DEB 建置。

## 安裝與升級

主服務支援 Alpine Linux 與 Ubuntu，且需要網路連線及可安裝系統套件的權限。`install` 與 `upgrade` 只安裝 Node.js 與主服務相依性，不會安裝或建置 Tauri。

全新環境：

```bash
./build.sh install
./build.sh setup
./start.sh
```

既有 Git checkout 升級：

```bash
./build.sh upgrade
./start.sh
```

`upgrade` 只允許 fast-forward 更新，並在工作樹有未提交變更時停止。它不會覆寫 `.env`、`src/config.ini`、storage、資料庫、users 或 logs。

### 舊版遷移

若版本早於 3.0.0，且 `git pull` 明確表示某些 tracked 檔案會被本機修改覆蓋，請先停止服務、備份 config，並且**只移走錯誤訊息列出的檔案**：

```bash
./stop.sh
mkdir -p ../filetransfer-local-backup
cp src/config.ini ../filetransfer-local-backup/config.ini
for file in package-lock.json start.sh stop.sh status.sh src/config.ini; do
  if ! git diff --quiet -- "$file" || ! git diff --cached --quiet -- "$file"; then
    mkdir -p "../filetransfer-local-backup/$(dirname "$file")"
    mv "$file" "../filetransfer-local-backup/$file"
  fi
done
git pull --ff-only
cp ../filetransfer-local-backup/config.ini src/config.ini
./build.sh upgrade
./start.sh
```

迴圈只移走有本機 Git 修改的檔案。不要還原舊的 `package-lock.json` 或 lifecycle scripts。暫時放回 `src/config.ini` 是為了讓 `build.sh upgrade` 將既有帳密、storage 路徑與 port 遷移至 ignored `.env`；成功後它保留為本機設定檔。

若外部網路必須經由 proxy，所有命令均可加上暫時性的 proxy：

```bash
./build.sh upgrade --proxy http://proxy.example.internal:8080
```

此參數只在該次執行中套用至 apk 或 apt、Git、npm、Cargo、curl 與 wget，不會寫入全域設定。

## 首次設定

`./build.sh setup` 會建立未追蹤的 `.env` 和 `src/config.ini`，再詢問 storage 路徑、管理員帳密、HTTP/HTTPS port 與可選的桌面預設 server address。實際位址、帳密、token 與憑證絕不應提交到 Git。

HTTP 預設 port 為 `9400`，HTTPS 預設 port 為 `9443`。HTTP redirect 只有在伺服器已具備有效 HTTPS 憑證時才會啟用。桌面客戶端固定使用 HTTPS，並將 server address 與 HTTPS port 分開輸入。

## Ubuntu Desktop DEB

只有 Ubuntu 22.04+ 負責建置桌面 package；這個命令才會安裝 Rust、GTK/WebKitGTK 與 Tauri 相依性：

```bash
./build.sh build
```

產物位於 `fileapi_ui/src-tauri/target/release/bundle/deb/`。DEB 不含內網 server address；使用者首次登入時輸入 address 和 HTTPS port，或在本機 `fileapi_ui/.env` 設定開發用預填值。

## 文件

- [完整 API 參考](docs/api/API_REFERENCE.md)
- [文件索引](docs/README.md)
- [Ubuntu Tauri 客戶端](fileapi_ui/README.md)

`fileapi.sh` 已淘汰，不是支援的 API 相容性目標。
