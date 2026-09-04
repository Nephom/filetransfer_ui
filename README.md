[English](README_EN.md)

# File Transfer Platform

本專案包含兩個產品面：上方是提供瀏覽器使用的 WebUI，下方是獨立的 nFterm Desktop App。兩者共用 API server 與權限模型，但執行環境、檔案能力與使用方式不同。

## WebUI 3.4.0-preview7

WebUI 是瀏覽器版檔案管理介面，提供：

- Location 檔案瀏覽、搜尋、上傳、下載、重新命名、刪除與資料夾操作。
- 多檔案與資料夾上傳，保留相對目錄結構並提供進度查詢。
- ZIP archive 下載、share link、到期與下載次數管理。
- JWT 登入、TLS、Location health、read-only 與 capability 權限控制。
- Admin Console 的使用者、Permission Role、Location 與系統設定管理。

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

## nFterm Desktop 3.4.0-preview7

nFterm 是 Tauri v2 desktop client，支援 Ubuntu 22.04+ 與 Windows 10/11。它使用 HTTPS 連線至 API server，並提供：

- LOCAL 與 API Remote 雙窗格檔案管理。
- SSH Terminal、SFTP browsing、SSH upload/download 與 remote archive 操作。
- Transfer Queue、進度、取消、bounded retry、失敗分類與中斷狀態恢復。
- REST API workspace，支援一般 REST、HPE iLO、OpenBMC、Redfish Session Auth 與 Redfish Actions。
- Proxmox VNC workspace，支援登入、VM discovery、VNC 連線、entry 隔離，以及透過對應模式與 VM 傳輸檔案。nFterm 執行機與 Proxmox Host 必須位於同一網段。
- VM 檔案傳輸模式：

  | VM 類型 | 與 nFterm 執行機同一網段（可互 ping） | 與 nFterm 執行機不同網段（不可互 ping） |
  | --- | --- | --- |
  | Linux VM | SFTP（via SSH） | SFTP（via Host jumping） |
  | Windows VM | 不支援 SSH/SFTP | 不支援 SSH/SFTP |
  | Windows VM（Proxmox API） | Proxmox 提供的 API 傳輸協議 | Proxmox 提供的 API 傳輸協議 |
- Windows VM 透過 Proxmox API 傳輸時，必須安裝 QEMU Guest Agent。VM 擁有者的權限必須包含 `VM.GuestAgent.FileRead`、`VM.GuestAgent.FileWrite` 與 `VM.GuestAgent.Unrestricted`。建議啟用全部 `VM.GuestAgent.*` 權限。
- **LXC 不支援這項操作。**
- 本地檔案 viewer、editor、archive、operation log 與 undo history。

### Desktop Build

Ubuntu：

```bash
./build.sh build
```

Windows build machine：

```powershell
.\build.ps1 build
```

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
