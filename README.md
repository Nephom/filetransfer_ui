[English](README_EN.md)

# Web-Based File Management System 3.3.2

提供檔案總管式網頁介面，以及可在 Ubuntu 與 Windows 執行的 Tauri v2 桌面客戶端。

## 功能

- 瀏覽器檔案總管：瀏覽、上傳、下載、重新命名、刪除、分享與資料夾 ZIP 下載。
- 具名、可重複使用的角色權限矩陣（每個 Location 各自的權限），可指派給使用者，並可在個別使用者身上覆寫。
- JWT 驗證、TLS 管理、可設定的安全功能與檔案快取。
- Ubuntu 22.04+ 與 Windows 10/11 Tauri v2 桌面客戶端（**nFterm**）：滑鼠導向的檔案總管介面。
- nFterm REST API mode：在 Workspace 中管理 REST API entries，支援 HPE iLO、OpenBMC 與一般 Redfish/REST API。
- REST API Session Auth：支援 HPE/OpenBMC Redfish SessionService、`X-Auth-Token` session、`@odata.id` 導覽、Redfish Actions、AHS/DownloadUri 下載與 GET path history。
- `build.sh`：Linux 的安裝、首次設定、更新、測試與 DEB 建置。
- `build.ps1`：Windows 建置機的桌面相依性檢查、更新建置與腳本自我更新。

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

Windows 建置機可以使用 PowerShell 流程。它只處理 Tauri 桌面客戶端，不接管主服務器的 `install/setup`：

```powershell
.\build.ps1 build
.\build.ps1 upgrade
.\build.ps1 self-upgrade
```

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

## Desktop Build

Ubuntu 22.04+ 使用 `build.sh` 建置 DEB：

```bash
./build.sh build
```

產物位於 `fileapi_ui/src-tauri/target/release/bundle/deb/`。

Windows 使用 `build.ps1` 建置 NSIS 安裝包與不需安裝的 portable EXE：

```powershell
.\build.ps1 build
```

portable EXE 位於 `fileapi_ui/src-tauri/target/release/nFterm.exe`；NSIS 產物位於 `fileapi_ui/src-tauri/target/release/bundle/nsis/`。Windows 執行檔使用目前使用者的 Desktop 作為本機檔案區預設目錄。

桌面客戶端已更名為 **nFterm**（原名 File Transfer Desktop / fileapi-desktop）；升級使用者可用 `upgrade_tools/migrate-desktop-data.ps1` 將舊資料目錄（`~/.fileapi-desktop`）搬移到新目錄（`~/.nFterm`）。

## REST API Mode

nFterm 的 REST API mode 與既有 `LOCATION` 檔案管理模式分開。切換至 REST API mode 後，左側顯示 Workspace 的 REST API entries，中間顯示 REST response reader；Terminal 與 SSH entries 保持不變。

REST API entry 可設定 Base URL、path、query parameters、TLS 選項與認證方式。HPE iLO 或 OpenBMC Redfish 可在 Authentication 選擇 `Session Auth`，再選擇對應的 `HPE` 或 `OpenBMC` preset。

Redfish 使用流程：

1. 選擇 `Session Auth`。
2. 輸入 Redfish username 與 password。
3. 選擇 `HPE` 或 `OpenBMC`。
4. 按 `Use Redfish SessionService preset`。
5. 按 `Login`。
6. 確認畫面顯示 REST session established。
7. 按 `GET` 開始瀏覽 `/redfish/v1`。

Reader 支援 `@odata.id`、`href`、`Members`、nested `Links`、Redfish `Actions.*.target`、最近 GET path history，以及 `DownloadUri` 等下載連結。Reset、Power、BIOS 或其他 action 會要求確認；Token、Cookie、password 不會寫入 Workspace JSON 或 operation log。

沒有實際 REST server 時，可使用 WSL2 sandbox：

```bash
node fileapi_ui/sandbox/rest-server.mjs
node fileapi_ui/sandbox/test-rest-server.mjs
```

Sandbox 預設位於 `http://127.0.0.1:8787`，測試帳號為 `sandbox`，密碼為 `sandbox`。

## 文件

- [完整 API 參考](docs/api/API_REFERENCE.md)
- [文件索引](docs/README.md)
- [WebUI 權限管理說明](docs/permissions.md)
- [Tauri 桌面客戶端](fileapi_ui/README.md)

`fileapi.sh` 已淘汰，不是支援的 API 相容性目標。
