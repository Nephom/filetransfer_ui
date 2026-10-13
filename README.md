[English](README_EN.md)

# File Transfer Platform

本專案包含兩個產品面：上方是提供瀏覽器使用的 WebUI，下方是獨立的 nFterm Desktop App。兩者共用 API server 與權限模型，但執行環境、檔案能力與使用方式不同。

## WebUI

WebUI 是瀏覽器版檔案管理介面，提供：

- Location 檔案瀏覽、搜尋、上傳、下載、重新命名、刪除與資料夾操作。
- 多檔案與資料夾上傳，續傳(4.0.0+)，保留相對目錄結構並提供進度查詢。
- ZIP archive 下載、share link、到期與下載次數管理。
- JWT 登入、TLS、Location health、read-only 與 capability 權限控制。
- Admin Console 的使用者、Permission Role、Location 與系統設定管理。
- 切換風格，目前具備Classic 和 Pane 兩種(4.0.0+)

### WebUI 安裝與啟動

主服務支援 Alpine Linux 與 Ubuntu。全新環境：

```bash
./build.sh install
./build.sh setup
./start.sh
```

既有 checkout 更新：

```bash
./build.sh upgrade
./start.sh
```

解除安裝時，預設只移除專案本地依賴與產生的設定，保留作業系統套件：

```bash
./uninstall.sh
```

若要移除 `build.sh install` 本次實際安裝且已記錄的系統套件：

```bash
./uninstall.sh --remove-system-dependencies
```

安裝紀錄保存在未納入版本控制的 `.filetransfer_install_manifest`。安裝前已存在的共用套件不會被列入或移除。

部署設定放在受保護且不納入版本控制的 `.env` 或 `src/config.ini`。實際位址、帳密、token、憑證與 storage 路徑不得寫入文件或 Git。

預設 HTTP port 為 `9400`，HTTPS port 為 `9443`。正式環境應使用受作業系統信任的 HTTPS 憑證。

## nFterm Desktop

nFterm 是 Tauri v2 desktop client，支援 Ubuntu 22.04+ 與 Windows 10/11。它使用 HTTPS 連線至 API server，並提供：

- LOCAL 與 API Remote 雙窗格檔案管理。
- Windows-only Browser pane，提供分開管理的網頁瀏覽與下載操作。
- SSH Terminal、SFTP browsing、SSH upload/download 與 remote archive 操作。
- Transfer Queue、進度、取消、bounded retry、失敗分類與中斷狀態恢復。
- REST API workspace，支援一般 REST、HPE iLO、OpenBMC、Redfish Session Auth 與 Redfish Actions。
- Proxmox VNC workspace，支援登入、VM discovery、VNC 連線與 entry 隔離。nFterm 必須能連線至 Proxmox HTTPS API；VM 檔案傳輸依 Guest Agent、直接 SFTP 或 Host SSH 跳板路徑決定，不要求同一子網。
- VNC workspace 上方提供 Direct VNC 圖卡，可透過標準 VNC password 連線到 macOS Screen Sharing 桌面；Direct VNC 僅提供畫面與輸入，不提供檔案傳輸。
- VM 檔案傳輸會先檢查 SSH 傳輸路徑，再視需要使用 QEMU Guest Agent；判斷依實際 SSH 可達性，不依 ping：

  | 條件 | 傳輸路徑 |
  | --- | --- |
  | VM 的 SSH 位址可直接連線 | Direct SFTP |
  | VM SSH 不可直接連線，但可透過 Proxmox Host 到達 | Host Jump SFTP |
  | QEMU Guest Agent 已安裝並回應，且 SSH 路徑不可用 | Guest Agent fallback（不支援資料夾下載，上傳受大小限制） |
  | LXC 已設定可達 VM IP 與 SSH | Direct SFTP 或 Host Jump SFTP；沒有 Guest Agent API |
- QEMU Guest Agent 檔案傳輸需要安裝 Agent 並授予 `VM.GuestAgent.FileRead`、`VM.GuestAgent.FileWrite` 與 `VM.GuestAgent.Unrestricted` 權限；建議啟用全部 `VM.GuestAgent.*` 權限。沒有 Guest Agent 路徑時，仍可依網路與 SSH 設定使用直接 SFTP 或 Host SSH 跳板；LXC 不支援 Guest Agent API 路徑。
- 本地檔案 viewer、editor、archive、operation log 與 undo history。

### Desktop Build

Ubuntu：

```bash
./build.sh build pre
```

以 `pre` 建置時，版本會附加 `-pre<commit hash>`；正式版請用 `./build.sh build ga`，版本不附加 commit hash。

Windows build machine：

```powershell
.\build.ps1 build pre
```

Windows 正式版可使用 `build.ps1 build ga`，版本不附加 commit hash。

產物位於：

- Linux DEB：`fileapi_ui/src-tauri/target/release/bundle/deb/`
- Windows portable EXE：`fileapi_ui/src-tauri/target/release/nFterm.exe`
- Windows NSIS：`fileapi_ui/src-tauri/target/release/bundle/nsis/`

### Desktop 安全行為

- API session token 只留在執行期間，不寫入 WebView localStorage。
- SSH、REST、Proxmox secret 使用 OS credential store；credential store 不可用時不會降級成明文或 Base64 檔案。
- 非 elevated 模式的本地檔案操作限制在使用者 HOME，並在寫入前檢查 canonical parent，避免 symlink/junction 脫離邊界。
- 下載使用 collision-safe filename；取消或失敗時清理 partial output。
- TLS certificate verification 預設開啟。只有使用者明確選擇 Ignore TLS errors 時才停用驗證。
- Proxmox localhost relay 使用一次性 token 與精確 WebSocket path；切換 entry 時會取消尚未建立的 pending relay。
- Desktop UI 僅支援 `en_US` 與 `zh_TW`；首次依 WebView 語系選擇，之後可從右上角 Account 選單切換並保存。

## API Contract

完整 server API 契約請參閱：

- [API Reference](docs/api/API_REFERENCE.md)
- [API Documentation](docs/api/README.md)
- [Upload API](docs/api/upload.md)
- [Progress API](docs/api/progress.md)
- [Error Codes](docs/api/error-codes.md)

## 技術文件

- [文件索引](docs/README.md)
- [Desktop Architecture](docs/desktop.md)
- [Transfer Queue](docs/queue.md)
- [Queue Maintenance](docs/queue-maintenance.md)
- [Locations](docs/locations.md)
- [Permission Management](docs/permissions.md)
- [Versioning](docs/versioning.md)
