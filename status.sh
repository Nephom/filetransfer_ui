#!/bin/bash

# File Transfer UI - 狀態檢查腳本
# 用途：檢查檔案傳輸系統服務狀態

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 配置
PID_FILE="server.pid"
LOG_FILE="server.log"
PORT=3000

echo -e "${CYAN}📊 File Transfer UI - 服務狀態${NC}"
echo -e "${CYAN}================================${NC}"

# 檢查 PID 文件
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    echo -e "${BLUE}📄 PID 文件：${NC}存在 ($PID_FILE)"
    
    # 檢查進程是否運行
    if ps -p $PID > /dev/null 2>&1; then
        echo -e "${GREEN}✅ 服務狀態：${NC}運行中 (PID: $PID)"
        
        # 獲取進程信息（兼容 macOS 和 Linux）
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            PROCESS_INFO=$(ps -p $PID -o pid,ppid,etime,pcpu,pmem,command | tail -n +2)
        else
            # Linux
            PROCESS_INFO=$(ps -p $PID -o pid,ppid,etime,pcpu,pmem,cmd --no-headers)
        fi
        echo -e "${BLUE}🔍 進程信息：${NC}"
        echo "   $PROCESS_INFO"
        
        # 檢查端口
        if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo -e "${GREEN}🌐 端口狀態：${NC}$PORT 正在監聽"
        else
            echo -e "${RED}❌ 端口狀態：${NC}$PORT 未監聽"
        fi
        
        # 檢查服務響應
        echo -e "${YELLOW}⏳ 檢查服務響應...${NC}"
        if curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT | grep -q "200\|302"; then
            echo -e "${GREEN}✅ 服務響應：${NC}正常"
        else
            echo -e "${RED}❌ 服務響應：${NC}無響應"
        fi
        
    else
        echo -e "${RED}❌ 服務狀態：${NC}進程不存在 (PID: $PID)"
        echo -e "${YELLOW}⚠️  建議清理 PID 文件${NC}"
    fi
else
    echo -e "${YELLOW}📄 PID 文件：${NC}不存在"
    
    # 檢查端口是否被其他進程占用
    PORT_PID=$(lsof -ti:$PORT 2>/dev/null)
    if [ -n "$PORT_PID" ]; then
        echo -e "${YELLOW}⚠️  端口 $PORT 被其他進程占用 (PID: $PORT_PID)${NC}"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            PROCESS_INFO=$(ps -p $PORT_PID -o pid,command | tail -n +2 2>/dev/null)
        else
            PROCESS_INFO=$(ps -p $PORT_PID -o pid,cmd --no-headers 2>/dev/null)
        fi
        echo -e "${BLUE}🔍 占用進程：${NC}$PROCESS_INFO"
    else
        echo -e "${GREEN}✅ 端口狀態：${NC}$PORT 可用"
    fi
    
    echo -e "${RED}❌ 服務狀態：${NC}未運行"
fi

# 檢查日誌文件
echo -e "${CYAN}================================${NC}"
if [ -f "$LOG_FILE" ]; then
    LOG_SIZE=$(du -h "$LOG_FILE" | cut -f1)
    LOG_LINES=$(wc -l < "$LOG_FILE")
    echo -e "${BLUE}📝 日誌文件：${NC}存在 ($LOG_FILE)"
    echo -e "${BLUE}📊 日誌大小：${NC}$LOG_SIZE ($LOG_LINES 行)"
    
    # 顯示最後幾行日誌
    echo -e "${BLUE}📋 最近日誌：${NC}"
    tail -n 3 "$LOG_FILE" 2>/dev/null | sed 's/^/   /' || echo -e "${YELLOW}   無法讀取日誌${NC}"
else
    echo -e "${YELLOW}📝 日誌文件：${NC}不存在"
fi

# 檢查配置文件
echo -e "${CYAN}================================${NC}"
CONFIG_FILE="src/config.ini"
if [ -f "$CONFIG_FILE" ]; then
    echo -e "${GREEN}⚙️  配置文件：${NC}存在 ($CONFIG_FILE)"
    
    # 讀取關鍵配置
    if command -v grep &> /dev/null; then
        PORT_CONFIG=$(grep "^port=" "$CONFIG_FILE" 2>/dev/null | cut -d'=' -f2)
        USERNAME=$(grep "^username=" "$CONFIG_FILE" 2>/dev/null | cut -d'=' -f2)
        STORAGE_PATH=$(grep "^storagePath=" "$CONFIG_FILE" 2>/dev/null | cut -d'=' -f2)
        
        echo -e "${BLUE}🔧 配置端口：${NC}${PORT_CONFIG:-未設置}"
        echo -e "${BLUE}👤 用戶名：${NC}${USERNAME:-未設置}"
        echo -e "${BLUE}📁 存儲路徑：${NC}${STORAGE_PATH:-未設置}"
    fi
else
    echo -e "${RED}❌ 配置文件：${NC}不存在"
fi

# 檢查存儲目錄
STORAGE_DIR="storage"
if [ -d "$STORAGE_DIR" ]; then
    FILE_COUNT=$(find "$STORAGE_DIR" -type f | wc -l)
    DIR_COUNT=$(find "$STORAGE_DIR" -type d | wc -l)
    STORAGE_SIZE=$(du -sh "$STORAGE_DIR" 2>/dev/null | cut -f1)
    
    echo -e "${GREEN}📁 存儲目錄：${NC}存在 ($STORAGE_DIR)"
    echo -e "${BLUE}📊 目錄統計：${NC}$FILE_COUNT 個文件, $DIR_COUNT 個目錄"
    echo -e "${BLUE}💾 存儲大小：${NC}$STORAGE_SIZE"
else
    echo -e "${YELLOW}📁 存儲目錄：${NC}不存在"
fi

echo -e "${CYAN}================================${NC}"

# 提供操作建議
if [ -f "$PID_FILE" ] && ps -p $(cat "$PID_FILE") > /dev/null 2>&1; then
    echo -e "${GREEN}💡 服務正在運行${NC}"
    echo -e "${BLUE}   🌐 訪問：${NC}http://localhost:$PORT"
    echo -e "${BLUE}   🛑 停止：${NC}./stop.sh"
    echo -e "${BLUE}   📝 日誌：${NC}tail -f $LOG_FILE"
else
    echo -e "${YELLOW}💡 服務未運行${NC}"
    echo -e "${BLUE}   🚀 啟動：${NC}./start.sh"
fi
