# Copyright 2024-2026 Simo contributors
# This is free software, licensed under the GNU General Public License v2.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-simo
PKG_VERSION:=0.2.3
PKG_RELEASE:=1
PKG_MAINTAINER:=ang3el7z

LUCI_TITLE:=LuCI Support for Simo
LUCI_DEPENDS:=+luci-base +kmod-tun
LUCI_PKGARCH:=all

PKG_CONFIG_DEPENDS:= \
	CONFIG_PACKAGE_$(PKG_NAME)_Iptables_Transparent_Proxy \
	CONFIG_PACKAGE_$(PKG_NAME)_Nftables_Transparent_Proxy

include $(TOPDIR)/feeds/luci/luci.mk

define Package/$(PKG_NAME)/config
choice
	prompt "Transparent Proxy Backend for Simo"
	default PACKAGE_$(PKG_NAME)_Iptables_Transparent_Proxy if !PACKAGE_firewall4
	default PACKAGE_$(PKG_NAME)_Nftables_Transparent_Proxy if PACKAGE_firewall4

config PACKAGE_$(PKG_NAME)_Iptables_Transparent_Proxy
	bool "Iptables Transparent Proxy"
	select PACKAGE_iptables-mod-tproxy

config PACKAGE_$(PKG_NAME)_Nftables_Transparent_Proxy
	bool "Nftables Transparent Proxy"
	select PACKAGE_kmod-nft-tproxy

endchoice
endef

define Package/$(PKG_NAME)/conffiles
/opt/simo/config.yaml
/opt/simo/config-singbox.json
endef

define Package/$(PKG_NAME)/preinst
#!/bin/sh
[ -f /opt/simo/config.yaml ] && cp -p /opt/simo/config.yaml /tmp/simo_config.yaml.bak
[ -f /opt/simo/config-singbox.json ] && cp -p /opt/simo/config-singbox.json /tmp/simo_config-singbox.json.bak
exit 0
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
if [ -f /tmp/simo_config.yaml.bak ]; then
	mv /tmp/simo_config.yaml.bak /opt/simo/config.yaml
fi
if [ -f /tmp/simo_config-singbox.json.bak ]; then
	mv /tmp/simo_config-singbox.json.bak /opt/simo/config-singbox.json
fi
	[ -n "$$IPKG_INSTROOT" ] || {
		mkdir -p /opt/simo/lst
		rm -f /tmp/luci-indexcache.*
		rm -rf /tmp/luci-modulecache/
		/etc/init.d/rpcd reload 2>/dev/null

		# Re-sync active core link after install/upgrade. This keeps /opt/simo/bin/core
		# aligned with CORE_TYPE in /opt/simo/settings when binaries already exist.
		/opt/simo/bin/simo-kernel-manager sync >/dev/null 2>&1 || true

		# Ensure periodic simo-rules update cron job exists
		CRON_FILE="/etc/crontabs/root"
	CRON_LINE="*/30 * * * * /opt/simo/bin/simo-rules update >/dev/null 2>&1"

	[ -f "$$CRON_FILE" ] || touch "$$CRON_FILE"
	if ! grep -Fq "/opt/simo/bin/simo-rules update" "$$CRON_FILE" 2>/dev/null; then
		echo "$$CRON_LINE" >> "$$CRON_FILE"
		/etc/init.d/cron restart >/dev/null 2>&1 || true
	fi
}
exit 0
endef

define Package/$(PKG_NAME)/postrm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] || {
	is_pkg_installed() {
		if [ -x /usr/bin/apk ] || [ -x /bin/apk ]; then
			APK_BIN="/usr/bin/apk"
			[ -x "$$APK_BIN" ] || APK_BIN="/bin/apk"
			"$$APK_BIN" info -e luci-app-simo >/dev/null 2>&1 && return 0
		fi
		if [ -x /bin/opkg ] || [ -x /usr/bin/opkg ]; then
			OPKG_BIN="/bin/opkg"
			[ -x "$$OPKG_BIN" ] || OPKG_BIN="/usr/bin/opkg"
			"$$OPKG_BIN" list-installed luci-app-simo >/dev/null 2>&1 && return 0
		fi
		return 1
	}

	# Clean up cron job for simo-rules update, if present
	CRON_FILE="/etc/crontabs/root"
	if [ -f "$$CRON_FILE" ]; then
		sed -i '\|/opt/simo/bin/simo-rules update|d' "$$CRON_FILE" 2>/dev/null || true
		/etc/init.d/cron restart >/dev/null 2>&1 || true
	fi

	rm -rf /opt/simo/ui
	rm -f /opt/simo/ruleset
	rm -rf /tmp/simo
	rm -rf /www/luci-static/resources/view/simo
	rm -f /usr/lib/lua/luci/i18n/simo.*.lmo
	rm -f /etc/hotplug.d/iface/40-simo
	rm -f /etc/hotplug.d/net/99-simo-tun
	rm -f /etc/apk/protected_paths.d/simo.list

	# Remove manually installed cores only on full package removal.
	case "$$1" in
		upgrade|update)
			;;
		*)
			if ! is_pkg_installed; then
				rm -f /opt/simo/bin/core
				rm -f /opt/simo/bin/mihomo
				rm -f /opt/simo/bin/sing-box
			fi
			;;
	esac
}
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
