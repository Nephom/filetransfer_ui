#!/bin/bash

# File Transfer UI - 停止腳本
# 用途：停止檔案傳輸系統服務

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

echo -e "${CYAN}🛑 File Transfer UI - 停止服務${NC}"
echo -e "${CYAN}================================${NC}"

# 檢查 PID 文件是否存在
if [ ! -f "$PID_FILE" ]; then
    echo -e "${YELLOW}⚠️  沒有找到 PID 文件，服務可能未運行${NC}"
    
    # 嘗試通過端口查找進程
    PID=$(lsof -ti:$PORT 2>/dev/null)
    if [ -n "$PID" ]; then
        echo -e "${BLUE}🔍 發現端口 $PORT 上的進程 (PID: $PID)${NC}"
        echo -e "${YELLOW}⚠️  嘗試停止該進程...${NC}"
        kill -TERM $PID 2>/dev/null
        sleep 2
        
        # 檢查是否成功停止
        if ps -p $PID > /dev/null 2>&1; then
            echo -e "${RED}❌ 無法正常停止進程，強制終止...${NC}"
            kill -KILL $PID 2>/dev/null
        fi
        
        echo -e "${GREEN}✅ 進程已停止${NC}"
    else
        echo -e "${GREEN}✅ 沒有發現運行中的服務${NC}"
    fi
    exit 0
fi

# 讀取 PID
PID=$(cat "$PID_FILE")

# 檢查進程是否存在
if ! ps -p $PID > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  進程 $PID 不存在，清理 PID 文件${NC}"
    rm -f "$PID_FILE"
    echo -e "${GREEN}✅ 清理完成${NC}"
    exit 0
fi

echo -e "${BLUE}🔍 找到運行中的服務 (PID: $PID)${NC}"

# 嘗試優雅停止
echo -e "${YELLOW}⏳ 正在停止服務...${NC}"
kill -TERM $PID 2>/dev/null

# 等待進程停止
WAIT_TIME=0
MAX_WAIT=10

while [ $WAIT_TIME -lt $MAX_WAIT ]; do
    if ! ps -p $PID > /dev/null 2>&1; then
        break
    fi
    sleep 1
    WAIT_TIME=$((WAIT_TIME + 1))
    echo -e "${BLUE}⏳ 等待進程停止... ($WAIT_TIME/$MAX_WAIT)${NC}"
done

# 檢查是否成功停止
if ps -p $PID > /dev/null 2>&1; then
    echo -e "${RED}⚠️  無法正常停止進程，強制終止...${NC}"
    kill -KILL $PID 2>/dev/null
    sleep 1
    
    if ps -p $PID > /dev/null 2>&1; then
        echo -e "${RED}❌ 無法停止進程 $PID${NC}"
        exit 1
    fi
fi

# 清理 PID 文件
rm -f "$PID_FILE"

echo -e "${GREEN}✅ 服務已成功停止${NC}"
echo -e "${CYAN}================================${NC}"
echo -e "${BLUE}📊 服務狀態：${NC}已停止"
echo -e "${BLUE}📝 日誌文件：${NC}$LOG_FILE (保留)"
echo -e "${PURPLE}💡 使用 ./start.sh 重新啟動服務${NC}"

# 顯示最後幾行日誌（如果存在）
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
    echo -e "${CYAN}================================${NC}"
    echo -e "${BLUE}📋 最後的日誌記錄：${NC}"
    tail -n 5 "$LOG_FILE" 2>/dev/null || echo -e "${YELLOW}無法讀取日誌文件${NC}"
fi
