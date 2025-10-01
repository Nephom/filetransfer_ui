#!/bin/bash

# File Transfer API Client Script (v2)
# Usage: ./fileapi_v2.sh <command> [options]

# Configuration
DEFAULT_HOST="http://localhost:9400"
HOST="${API_HOST:-$DEFAULT_HOST}"
TOKEN_FILE=".api_token"
CONFIG_FILE=".fileapi_config"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Load saved configuration
load_config() {
    if [[ -f "$CONFIG_FILE" ]]; then
        source "$CONFIG_FILE"
        if [[ -n "$SAVED_HOST" ]]; then
            HOST="$SAVED_HOST"
        fi
    fi
}

# Save configuration
save_config() {
    echo "SAVED_HOST=\"$HOST\"" > "$CONFIG_FILE"
    log_success "Configuration saved to $CONFIG_FILE"
}

# Get stored token
get_token() {
    if [[ -f "$TOKEN_FILE" ]]; then
        cat "$TOKEN_FILE"
    fi
}

# Save token
save_token() {
    echo "$1" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
}

# Make authenticated API request
api_request() {
    local method="$1"
    local endpoint="$2"
    local data="$3"
    local content_type="${4:-application/json}"
    
    local token=$(get_token)
    local headers=()
    
    if [[ -n "$token" ]]; then
        headers+=("-H" "Authorization: Bearer $token")
    fi
    
    if [[ -n "$data" ]]; then
        headers+=("-H" "Content-Type: $content_type")
        headers+=("-d" "$data")
    fi
    
    curl -s -X "$method" "${headers[@]}" "$HOST$endpoint"
}

# Authentication commands
cmd_login() {
    local username="$1"
    local password="$2"
    
    if [[ -z "$username" || -z "$password" ]]; then
        log_error "Usage: $0 login <username> <password>"
        exit 1
    fi
    
    log_info "Logging in to $HOST..."
    
    local response=$(api_request "POST" "/auth/login" "{\"username\":\"$username\",\"password\":\"$password\"}")
    local token=$(echo "$response" | jq -r '.token // empty')
    
    if [[ -n "$token" ]]; then
        save_token "$token"
        log_success "Login successful! Token saved."
        echo "$response" | jq . 2>/dev/null || echo "$response"
    else
        log_error "Login failed!"
        echo "$response" | jq . 2>/dev/null || echo "$response"
        exit 1
    fi
}

cmd_logout() {
    if [[ -f "$TOKEN_FILE" ]]; then
        rm "$TOKEN_FILE"
        log_success "Logged out successfully"
    else
        log_warning "Not logged in"
    fi
}

# File management commands
cmd_upload() {
    local file_path="$1"
    local target_path="$2"
    
    if [[ -z "$file_path" ]]; then
        log_error "Usage: $0 upload <file_path> [target_path]"
        exit 1
    fi
    
    if [[ ! -f "$file_path" ]]; then
        log_error "File not found: $file_path"
        exit 1
    fi
    
    local upload_path="${target_path:-}"
    
    log_info "Uploading $file_path to $HOST..."
    
    local token=$(get_token)
    if [[ -z "$token" ]]; then
        log_error "Not authenticated. Please login first."
        exit 1
    fi
    
    # Use multipart upload for files
    local response=$(curl -s -X POST \
        -H "Authorization: Bearer $token" \
        -F "files=@$file_path" \
        ${upload_path:+-F "currentPath=$upload_path"} \
        "$HOST/api/upload")
    
    if echo "$response" | grep -q '"success":true'; then
        log_success "File uploaded successfully!"
    else
        log_error "Upload failed!"
    fi
    
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

cmd_download() {
    local file_path="$1"
    local output_file="$2"
    
    if [[ -z "$file_path" ]]; then
        log_error "Usage: $0 download <remote_file_path> [local_output_file]"
        exit 1
    fi
    
    local output="${output_file:-$(basename "$file_path")}"
    
    log_info "Downloading $file_path from $HOST..."
    
    local token=$(get_token)
    if [[ -z "$token" ]]; then
        log_error "Not authenticated. Please login first."
        exit 1
    fi
    
    curl -s -H "Authorization: Bearer $token" \
        -o "$output" \
        "$HOST/api/files/download/$file_path"
    
    if [[ -f "$output" ]]; then
        log_success "File downloaded to: $output"
    else
        log_error "Download failed!"
        exit 1
    fi
}

cmd_list() {
    local path="$1"
    
    log_info "Listing files in: ${path:-/}"
    
    local endpoint="/api/files"
    if [[ -n "$path" ]]; then
        endpoint="/api/files/$path"
    fi
    
    local response=$(api_request "GET" "$endpoint")
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

cmd_delete() {
    local file_path="$1"
    
    if [[ -z "$file_path" ]]; then
        log_error "Usage: $0 delete <file_path>"
        exit 1
    fi
    
    log_info "Deleting: $file_path"
    
    local dirname=$(dirname "$file_path")
    local basename=$(basename "$file_path")
    
    if [[ "$dirname" == "." ]]; then
        dirname=""
    fi
    
    local data="{\"items\":[{\"name\":\"$basename\"}],\"currentPath\":\"$dirname\"}"
    
    local response=$(api_request "DELETE" "/api/files/delete" "$data")
    
    if echo "$response" | grep -q '"success":true'; then
        log_success "File deleted successfully!"
    else
        log_error "Delete failed!"
    fi
    
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

cmd_mkdir() {
    local folder_name="$1"
    local current_path="$2"
    
    if [[ -z "$folder_name" ]]; then
        log_error "Usage: $0 mkdir <folder_name> [current_path]"
        exit 1
    fi
    
    log_info "Creating folder: $folder_name"
    
    local data="{\"folderName\":\"$folder_name\""
    if [[ -n "$current_path" ]]; then
        data+=',"currentPath":"$current_path"'
    fi
    data+="}"
    
    local response=$(api_request "POST" "/api/folders" "$data")
    
    if echo "$response" | grep -q '"success":true'; then
        log_success "Folder created successfully!"
    else
        log_error "Folder creation failed!"
    fi
    
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

cmd_create() {
    local file_name="$1"
    local current_path="$2"
    local content="$3"
    
    if [[ -z "$file_name" ]]; then
        log_error "Usage: $0 create <file_name> [current_path] [content]"
        exit 1
    fi
    
    log_info "Creating file: $file_name"
    
    local data="{\"fileName\":\"$file_name\",\"content\":\"${content:-}\""
    if [[ -n "$current_path" ]]; then
        data+=',"currentPath":"$current_path"'
    fi
    data+="}"
    
    local response=$(api_request "POST" "/api/files/create" "$data")
    
    if echo "$response" | grep -q '"success":true'; then
        log_success "File created successfully!"
    else
        log_error "File creation failed!"
    fi
    
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

cmd_rename() {
    local old_name="$1"
    local new_name="$2"
    
    if [[ -z "$old_name" || -z "$new_name" ]]; then
        log_error "Usage: $0 rename <old_path> <new_path>"
        exit 1
    fi
    
    log_info "Renaming: $old_name -> $new_name"
    
    local data="{\"oldPath\":\"$old_name\",\"newPath\":\"$new_name\"}"
    
    local response=$(api_request "PUT" "/api/files/rename" "$data")
    
    if echo "$response" | grep -q '"success":true'; then
        log_success "File renamed successfully!"
    else
        log_error "Rename failed!"
    fi
    
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

cmd_copy() {
    local source_path="$1"
    local destination_path="$2"
    
    if [[ -z "$source_path" || -z "$destination_path" ]]; then
        log_error "Usage: $0 copy <source_path> <destination_path>"
        exit 1
    fi
    
    log_info "Copying: $source_path -> $destination_path"
    
    local data="{\"sourcePath\":\"$source_path\",\"destinationPath\":\"$destination_path\"}"
    local response=$(api_request "POST" "/api/files/copy" "$data")
    
    if echo "$response" | grep -q '"success":true'; then
        log_success "File copied successfully!"
    else
        log_error "Copy failed!"
    fi
    
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

cmd_move() {
    local source_path="$1"
    local destination_path="$2"
    
    if [[ -z "$source_path" || -z "$destination_path" ]]; then
        log_error "Usage: $0 move <source_path> <destination_path>"
        exit 1
    fi
    
    log_info "Moving: $source_path -> $destination_path"
    
    local data="{\"sourcePath\":\"$source_path\",\"destinationPath\":\"$destination_path\"}"
    local response=$(api_request "POST" "/api/files/move" "$data")
    
    if echo "$response" | grep -q '"success":true'; then
        log_success "File moved successfully!"
    else
        log_error "Move failed!"
    fi
    
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

# Search commands
cmd_search() {
    local query="$1"
    
    if [[ -z "$query" ]]; then
        log_error "Usage: $0 search <query>"
        exit 1
    fi
    
    log_info "Searching for: $query"
    
    local response=$(api_request "POST" "/api/files/search" "{\"query\":\"$query\"}")
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

# Cache management commands
cmd_cache_refresh() {
    local strategy="${1:-full}"
    local target_path="$2"
    
    log_info "Refreshing cache with strategy: $strategy"
    
    local data="{\"strategy\":\"$strategy\""
    if [[ -n "$target_path" ]]; then
        data+=',"targetPath":"$target_path"'
    fi
    data+="}"
    
    local response=$(api_request "POST" "/api/files/refresh-cache" "$data")
    
    if echo "$response" | grep -q '"success":true'; then
        log_success "Cache refresh completed!"
    else
        log_error "Cache refresh failed!"
    fi
    
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

cmd_cache_stats() {
    log_info "Getting cache statistics..."
    
    local response=$(api_request "GET" "/api/files/cache-stats")
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

# System commands
cmd_config() {
    local action="$1"
    local host="$2"
    
    case "$action" in
        "set-host")
            if [[ -z "$host" ]]; then
                log_error "Usage: $0 config set-host <host>"
                exit 1
            fi
            HOST="$host"
            save_config
            ;; 
        "show")
            echo "Current configuration:"
            echo "  Host: $HOST"
            echo "  Token file: $TOKEN_FILE"
            echo "  Config file: $CONFIG_FILE"
            if [[ -f "$TOKEN_FILE" ]]; then
                echo "  Authenticated: Yes"
            else
                echo "  Authenticated: No"
            fi
            ;; 
        *)
            log_error "Usage: $0 config <set-host|show> [value]"
            exit 1
            ;; 
    esac
}

# Help function
show_help() {
    cat << EOF
File Transfer API Client (v2)

Usage: $0 <command> [options]

Authentication:
  login <username> <password>    Login and save token
  logout                        Logout and remove token

File Management:
  upload <file> [target_path]   Upload a file
  download <path> [output]      Download a file
  list [path]                   List files in directory
  delete <path>                 Delete file or directory
  mkdir <name> [path]           Create directory
  create <name> [path] [content] Create file
  rename <old_path> <new_path>  Rename file or directory
  copy <source> <destination>   Copy file or directory
  move <source> <destination>   Move file or directory

Search:
  search <query>                Search files

Cache Management:
  cache-refresh [strategy] [path] Refresh cache
  cache-stats                   Get cache statistics

System:
  config <action> [value]       Configure client

Examples:
  $0 login admin password123
  $0 upload ./file.zip documents/
  $0 download documents/file.zip ./downloaded.zip
  $0 search "*.pdf"
  $0 cache-refresh smart

Environment Variables:
  API_HOST                      Override default host ($DEFAULT_HOST)

EOF
}

# Main script logic
main() {
    # Load configuration
    load_config
    
    if [[ $# -eq 0 ]]; then
        show_help
        exit 1
    fi
    
    local command="$1"
    shift
    
    case "$command" in
        "login")
            cmd_login "$@"
            ;; 
        "logout")
            cmd_logout "$@"
            ;; 
        "upload")
            cmd_upload "$@"
            ;; 
        "download")
            cmd_download "$@"
            ;; 
        "list")
            cmd_list "$@"
            ;; 
        "delete")
            cmd_delete "$@"
            ;; 
        "mkdir")
            cmd_mkdir "$@"
            ;; 
        "create")
            cmd_create "$@"
            ;; 
        "rename")
            cmd_rename "$@"
            ;; 
        "copy")
            cmd_copy "$@"
            ;; 
        "move")
            cmd_move "$@"
            ;; 
        "search")
            cmd_search "$@"
            ;; 
        "cache-refresh")
            cmd_cache_refresh "$@"
            ;; 
        "cache-stats")
            cmd_cache_stats "$@"
            ;; 
        "config")
            cmd_config "$@"
            ;; 
        "help"|"-h"|"--help")
            show_help
            ;; 
        *)
            log_error "Unknown command: $command"
            log_info "Use '$0 help' to see available commands"
            exit 1
            ;; 
    esac
}

# Run main function
main "$@"
