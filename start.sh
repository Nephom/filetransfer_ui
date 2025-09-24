#!/bin/bash

# File Transfer UI - 啟動腳本
# 用途：啟動檔案傳輸系統服務

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 配置
SERVER_FILE="src/backend/server.js"
PID_FILE="server.pid"
LOG_FILE="server.log"
CONFIG_FILE="src/config.ini"

# 從配置文件讀取端口
get_config_value() {
    local key=$1
    local config_file=$2
    if [ -f "$config_file" ]; then
        grep "^$key=" "$config_file" 2>/dev/null | cut -d'=' -f2 | tr -d ' \r\n'
    fi
}

# 讀取端口配置，如果讀取失敗則使用默認值
PORT=$(get_config_value "port" "$CONFIG_FILE")
if [ -z "$PORT" ]; then
    PORT=3000
    echo -e "${YELLOW}⚠️  無法從配置文件讀取端口，使用默認端口: $PORT${NC}"
else
    echo -e "${BLUE}📋 從配置文件讀取端口: $PORT${NC}"
fi

echo -e "${CYAN}🚀 File Transfer UI - 啟動服務${NC}"
echo -e "${CYAN}================================${NC}"

# 檢查 Node.js 是否安裝
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ 錯誤：Node.js 未安裝${NC}"
    echo -e "${YELLOW}請先安裝 Node.js: https://nodejs.org/${NC}"
    exit 1
fi

echo -e "${BLUE}🔧 正在檢查並安裝節點模組...${NC}"
npm install
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ 錯誤：節點模組安裝失敗。${NC}"
    exit 1
fi

# 檢查服務器文件是否存在
if [ ! -f "$SERVER_FILE" ]; then
    echo -e "${RED}❌ 錯誤：找不到服務器文件 $SERVER_FILE${NC}"
    exit 1
fi

# 檢查是否已經在運行
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p $PID > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  服務已經在運行中 (PID: $PID)${NC}"
        echo -e "${BLUE}💡 如需重啟，請先執行 ./stop.sh${NC}"
        exit 1
    else
        # PID 文件存在但進程不存在，清理舊文件
        rm -f "$PID_FILE"
    fi
fi

# 檢查端口是否被占用
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${RED}❌ 錯誤：端口 $PORT 已被占用${NC}"
    echo -e "${YELLOW}請檢查是否有其他服務在使用此端口${NC}"
    exit 1
fi

# 創建必要的目錄
echo -e "${BLUE}📁 檢查必要目錄...${NC}"
mkdir -p storage
mkdir -p logs

# 啟動服務器
echo -e "${GREEN}🌟 啟動檔案傳輸服務...${NC}"
nohup node "$SERVER_FILE" > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# 保存 PID
echo $SERVER_PID > "$PID_FILE"

# 等待服務器啟動
echo -e "${YELLOW}⏳ 等待服務器啟動...${NC}"
sleep 3

# 檢查服務器是否成功啟動
if ps -p $SERVER_PID > /dev/null 2>&1; then
    echo -e "${GREEN}✅ 服務器啟動成功！${NC}"
    echo -e "${CYAN}================================${NC}"
    echo -e "${GREEN}📡 服務器資訊：${NC}"
    echo -e "${BLUE}   🏠 本地訪問：${NC}http://localhost:$PORT"
    # 獲取本機 IP 地址（兼容 macOS 和 Linux）
    LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -n1)
    if [ -z "$LOCAL_IP" ]; then
        LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    fi
    echo -e "${BLUE}   🌍 網絡訪問：${NC}http://$LOCAL_IP:$PORT"
    echo -e "${BLUE}   🔐 登入帳號：${NC}admin / password"
    echo -e "${BLUE}   📝 日誌文件：${NC}$LOG_FILE"
    echo -e "${BLUE}   🆔 進程 ID：${NC}$SERVER_PID"
    echo -e "${CYAN}================================${NC}"
    echo -e "${PURPLE}💡 使用 ./stop.sh 停止服務${NC}"
    echo -e "${PURPLE}💡 使用 tail -f $LOG_FILE 查看日誌${NC}"
else
    echo -e "${RED}❌ 服務器啟動失敗${NC}"
    echo -e "${YELLOW}請檢查日誌文件：$LOG_FILE${NC}"
    rm -f "$PID_FILE"
    exit 1
fi
