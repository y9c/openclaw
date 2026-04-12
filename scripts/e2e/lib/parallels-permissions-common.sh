#!/usr/bin/env bash

parallels_macos_permission_check_snippet() {
  cat <<'EOF'
root="$("/opt/homebrew/bin/npm" root -g)"
check_path() {
  local path="$1"
  [ -e "$path" ] || return 0
  local perm perm_oct
  perm="$(/usr/bin/stat -f '%OLp' "$path")"
  perm_oct=$((8#$perm))
  if (( perm_oct & 0002 )); then
    echo "world-writable install artifact: $path ($perm)" >&2
    exit 1
  fi
}
check_path "$root/openclaw"
check_path "$root/openclaw/extensions"
if [ -d "$root/openclaw/extensions" ]; then
  while IFS= read -r -d '' extension_dir; do
    check_path "$extension_dir"
  done < <(/usr/bin/find "$root/openclaw/extensions" -mindepth 1 -maxdepth 1 -type d -print0)
fi
EOF
}

parallels_linux_permission_check_snippet() {
  cat <<'EOF'
root="$(npm root -g)"
check_path() {
  local path="$1"
  [ -e "$path" ] || return 0
  local perm perm_oct
  perm="$(stat -c '%a' "$path")"
  perm_oct=$((8#$perm))
  if (( perm_oct & 0002 )); then
    echo "world-writable install artifact: $path ($perm)" >&2
    exit 1
  fi
}
check_path "$root/openclaw"
check_path "$root/openclaw/extensions"
if [ -d "$root/openclaw/extensions" ]; then
  while IFS= read -r -d '' extension_dir; do
    check_path "$extension_dir"
  done < <(find "$root/openclaw/extensions" -mindepth 1 -maxdepth 1 -type d -print0)
fi
EOF
}
