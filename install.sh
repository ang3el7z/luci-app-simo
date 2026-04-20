#!/bin/sh
set -eu

SIMO_REPO="${SIMO_REPO:-ang3el7z/luci-app-simo}"
SIMO_PACKAGE="luci-app-simo"
RELEASE_API="https://api.github.com/repos/${SIMO_REPO}/releases/latest"
PKG_EXT=""
PKG_FILE=""

log() {
	printf '%s\n' "$*"
}

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

cleanup() {
	[ -n "${PKG_FILE}" ] && rm -f "${PKG_FILE}" || true
}

fetch_text() {
	local url="$1"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$url"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO- "$url"
	else
		die "Missing downloader (curl or wget)"
	fi
}

download_file() {
	local url="$1"
	local out="$2"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "$out" "$url"
	elif command -v wget >/dev/null 2>&1; then
		wget -O "$out" "$url"
	else
		die "Missing downloader (curl or wget)"
	fi
}

detect_pkg_manager() {
	if command -v apk >/dev/null 2>&1; then
		PKG_EXT="apk"
		PKG_FILE="/tmp/${SIMO_PACKAGE}.apk"
		return 0
	fi

	if command -v opkg >/dev/null 2>&1; then
		PKG_EXT="ipk"
		PKG_FILE="/tmp/${SIMO_PACKAGE}.ipk"
		return 0
	fi

	die "No supported package manager found (apk/opkg)"
}

extract_asset_url() {
	local json="$1"
	printf '%s\n' "$json" \
		| sed -n 's/.*"browser_download_url":[[:space:]]*"\([^"]*\)".*/\1/p' \
		| grep -E "${SIMO_PACKAGE}.*\.${PKG_EXT}$" \
		| head -n1
}

is_installed() {
	if [ "$PKG_EXT" = "apk" ]; then
		apk info -e "$SIMO_PACKAGE" >/dev/null 2>&1
	else
		opkg list-installed "$SIMO_PACKAGE" >/dev/null 2>&1
	fi
}

install_deps() {
	log "Refreshing package indexes..."
	if [ "$PKG_EXT" = "apk" ]; then
		apk update
		apk add curl kmod-tun >/dev/null 2>&1 || apk add curl kmod-tun
		apk add kmod-nft-tproxy >/dev/null 2>&1 || true
	else
		opkg update
		opkg install curl kmod-tun >/dev/null 2>&1 || opkg install curl kmod-tun
		opkg install kmod-nft-tproxy >/dev/null 2>&1 || opkg install iptables-mod-tproxy >/dev/null 2>&1 || true
	fi
}

install_package() {
	log "Fetching latest release metadata from ${SIMO_REPO}..."
	release_json=$(fetch_text "$RELEASE_API") || die "Unable to read latest release metadata"
	asset_url=$(extract_asset_url "$release_json" || true)
	[ -n "$asset_url" ] || die "No ${PKG_EXT} asset found for ${SIMO_PACKAGE} in the latest release"

	log "Downloading package: $asset_url"
	download_file "$asset_url" "$PKG_FILE" || die "Unable to download ${PKG_EXT} package"

	log "Installing package..."
	if [ "$PKG_EXT" = "apk" ]; then
		apk add --allow-untrusted "$PKG_FILE" || die "Package installation failed"
	else
		opkg install "$PKG_FILE" || die "Package installation failed"
	fi
}

remove_package() {
	if ! is_installed; then
		log "${SIMO_PACKAGE} is not installed"
		return 0
	fi

	log "Removing ${SIMO_PACKAGE}..."
	if [ "$PKG_EXT" = "apk" ]; then
		apk del "$SIMO_PACKAGE" || die "Package removal failed"
	else
		opkg remove "$SIMO_PACKAGE" || die "Package removal failed"
	fi
}

trap cleanup EXIT HUP INT TERM

ACTION="${1:-install}"
detect_pkg_manager

case "$ACTION" in
	install|update)
		install_deps
		install_package
		log "${SIMO_PACKAGE} installed successfully."
		;;
	reinstall)
		install_deps
		remove_package
		install_package
		log "${SIMO_PACKAGE} reinstalled successfully."
		;;
	remove|uninstall)
		remove_package
		log "${SIMO_PACKAGE} removed successfully."
		;;
	*)
		die "Usage: $0 [install|update|reinstall|remove]"
		;;
esac
