#!/bin/bash

# File Transfer UI - Status Check Script
# Purpose: To check the status of the file transfer system service

# Color Definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
PID_FILE="server.pid"
LOG_FILE="server.log"
CONFIG_FILE="src/config.ini"

# Read port from config file
get_config_value() {
    local key=$1
    local config_file=$2
    if [ -f "$config_file" ]; then
        grep "^$key=" "$config_file" 2>/dev/null | cut -d'=' -f2 | tr -d ' \r\n'
    fi
}

# Read port configuration, use default if failed
PORT=$(get_config_value "port" "$CONFIG_FILE")
if [ -z "$PORT" ]; then
    PORT=3000
fi

echo -e "${CYAN}📊 File Transfer UI - Service Status${NC}"
echo -e "${CYAN}======================================${NC}"

# Check PID file
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    echo -e "${BLUE}📄 PID File:      ${NC}Found ($PID_FILE)"
    
    # Check if process is running
    if ps -p $PID > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Service Status:  ${NC}Running (PID: $PID)"
        
        # Get process info (macOS and Linux compatible)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            PROCESS_INFO=$(ps -p $PID -o pid,ppid,etime,pcpu,pmem,command | tail -n +2)
        else
            # Linux
            PROCESS_INFO=$(ps -p $PID -o pid,ppid,etime,pcpu,pmem,cmd --no-headers)
        fi
        echo -e "${BLUE}🔍 Process Info:  ${NC}"
        echo "   $PROCESS_INFO"
        
        # Check port
        if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo -e "${GREEN}🌐 Port Status:     ${NC}$PORT is Listening"
        else
            echo -e "${RED}❌ Port Status:     ${NC}$PORT is Not Listening"
        fi
        
        # Check service response
        echo -e "${YELLOW}⏳ Checking service response...${NC}"
        if curl -s -o /dev/null -w \"%{http_code}\" http://localhost:$PORT | grep -q "200\|302"; then
            echo -e "${GREEN}✅ Service Response:${NC} OK"
        else
            echo -e "${RED}❌ Service Response:${NC} No response"
        fi
        
    else
        echo -e "${RED}❌ Service Status:  ${NC}Process not found (PID: $PID)"
        echo -e "${YELLOW}⚠️  It's recommended to clean up the PID file${NC}"
    fi
else
    echo -e "${YELLOW}📄 PID File:      ${NC}Not found"
    
    # Check if port is used by another process
    PORT_PID=$(lsof -ti:$PORT 2>/dev/null)
    if [ -n "$PORT_PID" ]; then
        echo -e "${YELLOW}⚠️  Port $PORT is used by another process (PID: $PORT_PID)${NC}"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            PROCESS_INFO=$(ps -p $PORT_PID -o pid,command | tail -n +2 2>/dev/null)
        else
            PROCESS_INFO=$(ps -p $PORT_PID -o pid,cmd --no-headers 2>/dev/null)
        fi
        echo -e "${BLUE}🔍 Occupying Process: ${NC}$PROCESS_INFO"
    else
        echo -e "${GREEN}✅ Port Status:     ${NC}$PORT is Available"
    fi
    
    echo -e "${RED}❌ Service Status:  ${NC}Not Running"
fi

# Check log file
echo -e "${CYAN}======================================${NC}"
if [ -f "$LOG_FILE" ]; then
    LOG_SIZE=$(du -h "$LOG_FILE" | cut -f1)
    LOG_LINES=$(wc -l < "$LOG_FILE")
    echo -e "${BLUE}📝 Log File:      ${NC}Found ($LOG_FILE)"
    echo -e "${BLUE}📊 Log Size:      ${NC}$LOG_SIZE ($LOG_LINES lines)"
    
    # Show last few lines of log
    echo -e "${BLUE}📋 Recent Logs:   ${NC}"
    tail -n 3 "$LOG_FILE" 2>/dev/null | sed 's/^/   /' || echo -e "${YELLOW}   Could not read log${NC}"
else
    echo -e "${YELLOW}📝 Log File:      ${NC}Not found"
fi

# Check config file
echo -e "${CYAN}======================================${NC}"
CONFIG_FILE="src/config.ini"
if [ -f "$CONFIG_FILE" ]; then
    echo -e "${GREEN}⚙️  Config File:   ${NC}Found ($CONFIG_FILE)"
    
    # Read key configurations
    if command -v grep &> /dev/null; then
        PORT_CONFIG=$(grep "^port=" "$CONFIG_FILE" 2>/dev/null | cut -d'=' -f2)
        STORAGE_PATH=$(grep "^storagePath=" "$CONFIG_FILE" 2>/dev/null | cut -d'=' -f2)
        
        echo -e "${BLUE}🔧 Configured Port:${NC}${PORT_CONFIG:-Not set}"
        echo -e "${BLUE}📁 Storage Path:  ${NC}${STORAGE_PATH:-Not set}"
    fi
else
    echo -e "${RED}❌ Config File:   ${NC}Not found"
fi

# Check storage directory
STORAGE_DIR="storage"
if [ -d "$STORAGE_DIR" ]; then
    FILE_COUNT=$(find "$STORAGE_DIR" -type f | wc -l)
    DIR_COUNT=$(find "$STORAGE_DIR" -type d | wc -l)
    STORAGE_SIZE=$(du -sh "$STORAGE_DIR" 2>/dev/null | cut -f1)
    
    echo -e "${GREEN}📁 Storage Dir:   ${NC}Found ($STORAGE_DIR)"
    echo -e "${BLUE}📊 Directory Stats:${NC}$FILE_COUNT files, $DIR_COUNT directories"
    echo -e "${BLUE}💾 Storage Size:  ${NC}$STORAGE_SIZE"
else
    echo -e "${YELLOW}📁 Storage Dir:   ${NC}Not found"
fi

echo -e "${CYAN}======================================${NC}"

# Provide suggestions
if [ -f "$PID_FILE" ] && ps -p $(cat "$PID_FILE") > /dev/null 2>&1; then
    echo -e "${GREEN}💡 Service is running${NC}"
    echo -e "${BLUE}   🌐 Access: ${NC}http://localhost:$PORT"
    echo -e "${BLUE}   🛑 Stop:   ${NC}./stop.sh"
    echo -e "${BLUE}   📝 Logs:   ${NC}tail -f $LOG_FILE"
else
    echo -e "${YELLOW}💡 Service is not running${NC}"
    echo -e "${BLUE}   🚀 Start:  ${NC}./start.sh"
fi