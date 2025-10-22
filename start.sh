#!/bin/bash

# File Transfer UI - Start Script
# Purpose: To start the file transfer system service

# Color Definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
SERVER_FILE="src/backend/server.js"
PID_FILE="server.pid"
LOCK_FILE="server.lock"
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
    echo -e "${YELLOW}⚠️  Could not read port from config file, using default: $PORT${NC}"
else
    echo -e "${BLUE}📋 Reading port from config file: $PORT${NC}"
fi

echo -e "${CYAN}🚀 File Transfer UI - Starting Service${NC}"
echo -e "${CYAN}======================================${NC}"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Error: Node.js is not installed.${NC}"
    echo -e "${YELLOW}Please install Node.js first: https://nodejs.org/${NC}"
    exit 1
fi

# Check if node_modules directory exists, install only if it doesn't
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}🔧 Node modules not found. Installing dependencies...${NC}"
    npm install
    if [ $? -ne 0 ]; then
        echo -e "${RED}❌ Error: Node module installation failed.${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✅ Node modules found. Skipping installation.${NC}"
fi

# Check if server file exists
if [ ! -f "$SERVER_FILE" ]; then
    echo -e "${RED}❌ Error: Server file not found at $SERVER_FILE${NC}"
    exit 1
fi

# Check for active restart lock
if [ -f "$LOCK_FILE" ]; then
    echo -e "${YELLOW}⚠️  Restart lock detected${NC}"

    # Read lock information
    LOCK_TIMESTAMP=$(grep -o '"timestamp":"[^"]*"' "$LOCK_FILE" 2>/dev/null | cut -d'"' -f4)
    LOCK_INITIATOR=$(grep -o '"initiator":"[^"]*"' "$LOCK_FILE" 2>/dev/null | cut -d'"' -f4)
    LOCK_METHOD=$(grep -o '"method":"[^"]*"' "$LOCK_FILE" 2>/dev/null | cut -d'"' -f4)

    if [ -n "$LOCK_TIMESTAMP" ]; then
        echo -e "${BLUE}   Locked by: ${NC}$LOCK_INITIATOR ($LOCK_METHOD)"
        echo -e "${BLUE}   Time: ${NC}$LOCK_TIMESTAMP"

        # Check if lock is stale (older than 2 minutes = 120 seconds)
        if command -v date &> /dev/null; then
            LOCK_TIME=$(date -d "$LOCK_TIMESTAMP" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${LOCK_TIMESTAMP%.*}" +%s 2>/dev/null)
            CURRENT_TIME=$(date +%s)

            if [ -n "$LOCK_TIME" ]; then
                LOCK_AGE=$((CURRENT_TIME - LOCK_TIME))

                if [ $LOCK_AGE -gt 120 ]; then
                    echo -e "${YELLOW}   Lock is stale (${LOCK_AGE}s old), removing...${NC}"
                    rm -f "$LOCK_FILE"
                else
                    echo -e "${RED}❌ Service is being restarted by another process${NC}"
                    echo -e "${BLUE}💡 Please wait for the restart to complete${NC}"
                    exit 1
                fi
            fi
        fi
    else
        # Invalid lock file, remove it
        echo -e "${YELLOW}   Invalid lock file, removing...${NC}"
        rm -f "$LOCK_FILE"
    fi
fi

# Check if already running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p $PID > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  Service is already running (PID: $PID)${NC}"
        echo -e "${BLUE}💡 To restart, run ./stop.sh first${NC}"
        exit 1
    else
        # PID file exists but process does not, cleaning up old file
        rm -f "$PID_FILE"
    fi
fi

# Check if port is in use
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${RED}❌ Error: Port $PORT is already in use${NC}"
    echo -e "${YELLOW}Please check if another service is using this port${NC}"
    exit 1
fi

# Create necessary directories
echo -e "${BLUE}📁 Checking for necessary directories...${NC}"
mkdir -p storage
mkdir -p logs

# Create lock file to prevent concurrent restarts
echo -e "${BLUE}🔒 Creating restart lock...${NC}"
cat > "$LOCK_FILE" << EOF
{
  "pid": $$,
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
  "initiator": "shell",
  "method": "shell"
}
EOF

# Start the server
echo -e "${GREEN}🌟 Starting File Transfer Service...${NC}"
nohup node "$SERVER_FILE" > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Save PID (will be overwritten by Node.js after successful startup)
echo $SERVER_PID > "$PID_FILE"

# Wait for the server to start
echo -e "${YELLOW}⏳ Waiting for server to start...${NC}"
sleep 3

# Check if server started successfully
if ps -p $SERVER_PID > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Server started successfully!${NC}"
    echo -e "${BLUE}🔓 Lock will be released by server after complete initialization${NC}"
    echo -e "${CYAN}======================================${NC}"
    echo -e "${GREEN}📡 Server Information:${NC}"
    echo -e "${BLUE}   🏠 Local Access:  ${NC}http://localhost:$PORT"
    # Get local IP address (macOS and Linux compatible)
    LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -n1)
    if [ -z "$LOCAL_IP" ]; then
        LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    fi
    echo -e "${BLUE}   🌍 Network Access:${NC}http://$LOCAL_IP:$PORT"
    echo -e "${BLUE}   🆔 Process ID:    ${NC}$SERVER_PID"
    echo -e "${BLUE}   📝 Log File:      ${NC}$LOG_FILE"
    echo -e "${CYAN}======================================${NC}"
    echo -e "${PURPLE}💡 Use ./stop.sh to stop the service${NC}"
    echo -e "${PURPLE}💡 Use tail -f $LOG_FILE to view logs${NC}"
else
    echo -e "${RED}❌ Server failed to start${NC}"
    echo -e "${YELLOW}Please check the log file: $LOG_FILE${NC}"
    rm -f "$PID_FILE"
    exit 1
fi