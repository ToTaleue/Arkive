#!/bin/bash
# Arkive adapter for the bundled Mole version. Discovery only: never call
# batch_uninstall_applications, confirmation, removals, brew uninstall or sudo.
set -euo pipefail
export MOLE_DRY_RUN=1 MOLE_DELETE_MODE=trash
adapter_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$adapter_dir/bin/uninstall.sh" >&2

# Mole groups incomplete checks under "some paths unreadable", including
# receipt timeouts. Retain its actual cause without enabling persistent debug
# logging or changing discovery/protection rules. Subshells inherit this hook.
export MO_DEBUG=1
debug_log() {
    case "$*" in
        'Sibling '* | 'Could not complete the live same-bundle scan '*)
            printf 'ARKIVE_MOLE_DIAGNOSTIC: %s\n' "$*" >&2
            ;;
    esac
    return 0
}

[[ $# -gt 0 && $# -le 20 ]] || exit 2
selected_apps=()
for app_path in "$@"; do
    [[ "$app_path" == /* && "$app_path" == *.[aA][pP][pP] && -d "$app_path" ]] || exit 2
    case "$app_path" in *'|'* | *$'\n'* | *$'\r'*) exit 2 ;; esac
    bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist")
    app_name="${app_path##*/}"
    selected_apps+=("0|$app_path|${app_name%.*}|$bundle_id|0|Unknown")
done

running_apps=() sudo_apps=() brew_cask_apps=() blocked_apps=()
manual_removal_apps=() leftover_notes=() app_details=()
total_estimated_size=0
_batch_scan_stage='application inspection'
_batch_scan_app_name=''
_batch_scan_app_details >&2

# NUL-delimited, fixed-width records preserve spaces and terminal characters.
# Native app_details binds bundle identity and surviving sibling installations.
printf 'arkive-uninstall-v1\0'
for detail in ${app_details[@]+"${app_details[@]}"}; do
    IFS='|' read -r name path bundle total files system sensitive sudo_needed brew cask diag review login sibling identity original live info <<< "$detail"
    printf 'app\0%s\0%s\0%s\0' "$path" "$bundle" "$brew|$cask|$sibling|$identity|$original|$live|$info"
    printf 'candidate\0%s\0%s\0app\0' "$path" "$path"
    related=$(decode_file_list "$files" "$name")
    while IFS= read -r candidate; do
        [[ -n "$candidate" ]] || continue
        printf 'candidate\0%s\0%s\0related\0' "$path" "$candidate"
    done <<< "$related"
    review_paths=$(decode_file_list "$review" "$name")
    while IFS= read -r candidate; do
        [[ -n "$candidate" ]] || continue
        printf 'review\0%s\0%s\0\0' "$path" "$candidate"
    done <<< "$review_paths"
    if [[ "$brew" == true ]]; then
        printf 'warning\0%s\0%s\0\0' "$path" 'Homebrew-managed app: Arkive only moves selected paths to Trash; Homebrew registration and uninstall hooks are not changed.'
    fi
done
for note in ${leftover_notes[@]+"${leftover_notes[@]}"}; do
    printf 'warning\0\0%s\0\0' "$note"
done
for note in ${blocked_apps[@]+"${blocked_apps[@]}"}; do
    printf 'warning\0\0%s\0\0' "Official uninstaller required: $note"
done
for note in ${manual_removal_apps[@]+"${manual_removal_apps[@]}"}; do
    printf 'warning\0\0%s\0\0' "Manual removal required: $note"
done
for note in ${running_apps[@]+"${running_apps[@]}"}; do
    printf 'warning\0\0%s\0\0' "Application is running; quit it before removal: $note"
done
