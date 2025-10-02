#!/bin/bash

# File Transfer UI - Stop Script
# Purpose: To stop the file transfer system service

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

echo -e "${CYAN}🛑 File Transfer UI - Stopping Service${NC}"
echo -e "${CYAN}======================================${NC}"

# Check if PID file exists
if [ ! -f "$PID_FILE" ]; then
    echo -e "${YELLOW}⚠️  PID file not found, service may not be running${NC}"
    
    # Attempt to find the process by port
    PID=$(lsof -ti:$PORT 2>/dev/null)
    if [ -n "$PID" ]; then
        echo -e "${BLUE}🔍 Found process on port $PORT (PID: $PID)${NC}"
        echo -e "${YELLOW}⚠️  Attempting to stop this process...${NC}"
        kill -TERM $PID 2>/dev/null
        sleep 2
        
        # Check if stopped successfully
        if ps -p $PID > /dev/null 2>&1; then
            echo -e "${RED}❌ Could not stop the process gracefully, forcing termination...${NC}"
            kill -KILL $PID 2>/dev/null
        fi
        
        echo -e "${GREEN}✅ Process stopped${NC}"
    else
        echo -e "${GREEN}✅ No running service found${NC}"
    fi
    exit 0
fi

# Read PID
PID=$(cat "$PID_FILE")

# Check if process exists
if ! ps -p $PID > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Process $PID does not exist, cleaning up PID file${NC}"
    rm -f "$PID_FILE"
    echo -e "${GREEN}✅ Cleanup complete${NC}"
    exit 0
fi

echo -e "${BLUE}🔍 Found running service (PID: $PID)${NC}"

# Attempt to stop gracefully
echo -e "${YELLOW}⏳ Stopping service...${NC}"
kill -TERM $PID 2>/dev/null

# Wait for process to stop
WAIT_TIME=0
MAX_WAIT=10

while [ $WAIT_TIME -lt $MAX_WAIT ]; do
    if ! ps -p $PID > /dev/null 2>&1; then
        break
    fi
    sleep 1
    WAIT_TIME=$((WAIT_TIME + 1))
    echo -e "${BLUE}⏳ Waiting for process to stop... ($WAIT_TIME/$MAX_WAIT)${NC}"
done

# Check if stopped successfully
if ps -p $PID > /dev/null 2>&1; then
    echo -e "${RED}⚠️  Could not stop the process gracefully, forcing termination...${NC}"
    kill -KILL $PID 2>/dev/null
    sleep 1
    
    if ps -p $PID > /dev/null 2>&1; then
        echo -e "${RED}❌ Failed to stop process $PID${NC}"
        exit 1
    fi
fi

# Clean up PID file
rm -f "$PID_FILE"

echo -e "${GREEN}✅ Service stopped successfully${NC}"
echo -e "${CYAN}======================================${NC}"
echo -e "${BLUE}📊 Service Status: ${NC}Stopped"
echo -e "${BLUE}📝 Log File:       ${NC}$LOG_FILE (Retained)"
echo -e "${PURPLE}💡 Use ./start.sh to restart the service${NC}"

# Show last few lines of log if it exists
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
    echo -e "${CYAN}======================================${NC}"
    echo -e "${BLUE}📋 Last Log Entries:${NC}"
    tail -n 5 "$LOG_FILE" 2>/dev/null || echo -e "${YELLOW}Could not read log file${NC}"
fi