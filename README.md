# luci-app-simo

[Read in Russian](./README.ru.md)

`luci-app-simo` is a LuCI app for OpenWrt with one unified control surface (`simo`) and switchable runtime kernels.

## Highlights

- one UI and one service: `simo`
- runtime binaries under `/opt/simo/bin/`
- seamless kernel switching through `/opt/simo/bin/simo-kernel-manager`
- shared operating model for `tun` / `tproxy` / `mixed`
- package-first lifecycle for both `.ipk` and `.apk`

## Install

```bash
wget -O /root/install.sh https://raw.githubusercontent.com/ang3el7z/luci-app-simo/main/install.sh && chmod 0755 /root/install.sh && sh /root/install.sh
```

Installer actions:

- `sh /root/install.sh install`
- `sh /root/install.sh update`
- `sh /root/install.sh reinstall`
- `sh /root/install.sh remove`

## Build

```bash
docker build -f Dockerfile-ipk -t simo-ipk .
docker build -f Dockerfile-apk -t simo-apk .
```

## License

MIT. See [LICENSE](./LICENSE).