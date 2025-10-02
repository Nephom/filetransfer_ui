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

# Start the server
echo -e "${GREEN}🌟 Starting File Transfer Service...${NC}"
nohup node "$SERVER_FILE" > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Save PID
echo $SERVER_PID > "$PID_FILE"

# Wait for the server to start
echo -e "${YELLOW}⏳ Waiting for server to start...${NC}"
sleep 3

# Check if server started successfully
if ps -p $SERVER_PID > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Server started successfully!${NC}"
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