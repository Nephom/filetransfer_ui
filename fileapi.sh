#!/bin/bash

# File Transfer API Client Script (v3)
# Usage: ./fileapi.sh <command> [options]

# Configuration
DEFAULT_HOST="http://localhost:3000"
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

    if [[ -f "$output" && $(stat -f%z "$output" 2>/dev/null || stat -c%s "$output" 2>/dev/null) -gt 0 ]]; then
        log_success "File downloaded to: $output"
    else
        log_error "Download failed!"
        rm -f "$output" # Clean up empty file
        exit 1
    fi
}

cmd_archive() {
    local output_file="$1"
    local current_path="$2"
    shift 2
    local items=("$@")

    if [[ -z "$output_file" || -z "$current_path" || ${#items[@]} -eq 0 ]]; then
        log_error "Usage: $0 archive <output_file.zip> <current_path> <item1> [item2] ..."
        log_info "Example: $0 archive backup.zip documents/ file1.txt folder1"
        exit 1
    fi

    log_info "Creating archive $output_file from items in $current_path..."

    local json_items="["
    for item in "${items[@]}"; do
        json_items+="{\"name\":\"$item\"},"
    done
    json_items="${json_items%,}" # Remove trailing comma
    json_items+="]"

    local data="{\"items\":$json_items,\"currentPath\":\"$current_path\"}"

    local token=$(get_token)
    if [[ -z "$token" ]]; then
        log_error "Not authenticated. Please login first."
        exit 1
    fi

    curl -s -X POST \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$data" \
        -o "$output_file" \
        "$HOST/api/archive"

    if [[ -f "$output_file" && $(stat -f%z "$output_file" 2>/dev/null || stat -c%s "$output_file" 2>/dev/null) -gt 0 ]]; then
        log_success "Archive created: $output_file"
    else
        log_error "Archive creation failed!"
        rm -f "$output_file" # Clean up empty file
        exit 1
    fi
}

cmd_list() {
    local path="$1"

    log_info "Listing files in: ${path:-/}"

    # Use query parameter for path
    local endpoint="/api/files"
    if [[ -n "$path" ]]; then
        endpoint="/api/files?path=$path"
    fi

    local response=$(api_request "GET" "$endpoint")
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

cmd_delete() {
    local current_path="$1"
    shift
    local items=("$@")

    if [[ ${#items[@]} -eq 0 ]]; then
        log_error "Usage: $0 delete <current_path> <item1> [item2] ..."
        log_info "Example: $0 delete documents/ file1.txt folder1"
        exit 1
    fi

    log_info "Deleting ${#items[@]} item(s) from $current_path..."

    # Build JSON array of items
    local json_items="["
    for item in "${items[@]}"; do
        json_items+="{\"name\":\"$item\"},"
    done
    json_items="${json_items%,}" # Remove trailing comma
    json_items+="]"

    local data="{\"items\":$json_items,\"currentPath\":\"$current_path\"}"

    local response=$(api_request "DELETE" "/api/files/delete" "$data")

    if echo "$response" | grep -q '"success":true'; then
        log_success "Items deleted successfully!"
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
        log_info "Example: $0 mkdir newfolder documents/"
        exit 1
    fi

    log_info "Creating folder: $folder_name"

    local data="{\"folderName\":\"$folder_name\""
    if [[ -n "$current_path" ]]; then
        data+=",\"currentPath\":\"$current_path\""
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
        log_info "Example: $0 create test.txt documents/ \"Hello World\""
        exit 1
    fi

    log_info "Creating file: $file_name"

    local data="{\"fileName\":\"$file_name\",\"content\":\"${content:-}\""
    if [[ -n "$current_path" ]]; then
        data+=",\"currentPath\":\"$current_path\""
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
    local current_path="$3"

    if [[ -z "$old_name" || -z "$new_name" ]]; then
        log_error "Usage: $0 rename <old_name> <new_name> [current_path]"
        log_info "Example: $0 rename oldfile.txt newfile.txt documents/"
        exit 1
    fi

    log_info "Renaming: $old_name -> $new_name"

    local data="{\"oldName\":\"$old_name\",\"newName\":\"$new_name\""
    if [[ -n "$current_path" ]]; then
        data+=",\"currentPath\":\"$current_path\""
    fi
    data+="}"

    local response=$(api_request "PUT" "/api/files/rename" "$data")

    if echo "$response" | grep -q '"success":true'; then
        log_success "File renamed successfully!"
    else
        log_error "Rename failed!"
    fi

    echo "$response" | jq . 2>/dev/null || echo "$response"
}

cmd_paste() {
    local operation="$1"  # copy or cut
    local target_path="$2"
    shift 2
    local items=("$@")

    if [[ -z "$operation" || -z "$target_path" || ${#items[@]} -eq 0 ]]; then
        log_error "Usage: $0 paste <copy|cut> <target_path> <source_item1> [source_item2] ..."
        log_info "Example: $0 paste copy documents/ file1.txt folder1/"
        exit 1
    fi

    if [[ "$operation" != "copy" && "$operation" != "cut" ]]; then
        log_error "Operation must be 'copy' or 'cut'"
        exit 1
    fi

    log_info "${operation^}ing ${#items[@]} item(s) to $target_path..."

    # Build JSON array of items
    local json_items="["
    for item in "${items[@]}"; do
        json_items+="{\"name\":\"$(basename "$item")\",\"sourcePath\":\"$item\"},"
    done
    json_items="${json_items%,}" # Remove trailing comma
    json_items+="]"

    local data="{\"items\":$json_items,\"operation\":\"$operation\",\"targetPath\":\"$target_path\"}"

    local response=$(api_request "POST" "/api/files/paste" "$data")

    if echo "$response" | grep -q '"success":true'; then
        log_success "Paste operation completed successfully!"
    else
        log_error "Paste failed!"
    fi

    echo "$response" | jq . 2>/dev/null || echo "$response"
}

# Search commands
cmd_search() {
    local query="$1"

    if [[ -z "$query" ]]; then
        log_error "Usage: $0 search <query>"
        log_info "Example: $0 search \"*.pdf\""
        exit 1
    fi

    log_info "Searching for: $query"

    local response=$(api_request "POST" "/api/files/search" "{\"query\":\"$query\"}")
    echo "$response" | jq . 2>/dev/null || echo "$response"
}

# Cache management commands
cmd_cache_refresh() {
    local directory_path="$1"

    log_info "Refreshing cache..."

    local data="{}"
    if [[ -n "$directory_path" ]]; then
        data="{\"directoryPath\":\"$directory_path\"}"
        log_info "Refreshing cache for directory: $directory_path"
    else
        log_info "Refreshing entire file system cache"
    fi

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

cmd_cache_clear() {
    log_info "Clearing file cache (admin only)..."

    local response=$(api_request "POST" "/api/admin/cache/clear")

    if echo "$response" | grep -q '"success":true'; then
        log_success "Cache cleared successfully!"
    else
        log_error "Cache clear failed! (requires admin privileges)"
    fi

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
                log_info "Example: $0 config set-host http://192.168.1.100:3000"
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
File Transfer API Client (v3)
Updated to match current server API structure

Usage: $0 <command> [options]

Authentication:
  login <username> <password>           Login and save token
  logout                                Logout and remove token

File Management:
  upload <file> [target_path]           Upload a file
  download <path> [output]              Download a file
  archive <out.zip> <path> ...items     Create a zip archive of multiple items
  list [path]                           List files in directory
  delete <path> <item1> [item2...]      Delete files/folders
  mkdir <name> [path]                   Create directory
  create <name> [path] [content]        Create file
  rename <old> <new> [path]             Rename file or directory
  paste <copy|cut> <target> <src...>    Copy or move files

Search:
  search <query>                        Search files

Cache Management:
  cache-refresh [path]                  Refresh cache (optionally specific directory)
  cache-stats                           Get cache statistics
  cache-clear                           Clear cache (admin only)

System:
  config <action> [value]               Configure client
    set-host <host>                     Set API host URL
    show                                Show current configuration

Examples:
  $0 login admin password123
  $0 upload ./file.zip documents/
  $0 download documents/file.zip ./downloaded.zip
  $0 archive backup.zip documents/ file1.txt folder1
  $0 delete documents/ file1.txt file2.txt
  $0 rename oldfile.txt newfile.txt documents/
  $0 paste copy backup/ documents/file1.txt documents/file2.txt
  $0 search "*.pdf"
  $0 cache-refresh documents/

Environment Variables:
  API_HOST                              Override default host ($DEFAULT_HOST)

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
        "archive")
            cmd_archive "$@"
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
        "paste")
            cmd_paste "$@"
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
        "cache-clear")
            cmd_cache_clear "$@"
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
