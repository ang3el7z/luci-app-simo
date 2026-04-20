# luci-app-simo

[Read in English](./README.md)

`luci-app-simo` — LuCI-приложение для OpenWrt с единой панелью управления `simo` и переключаемыми runtime-ядрами.

## Основные возможности

- единый UI и единый сервис: `simo`
- бинарники ядер в `/opt/simo/bin/`
- бесшовное переключение ядра через `/opt/simo/bin/simo-kernel-manager`
- общая модель работы режимов `tun` / `tproxy` / `mixed`
- package-first lifecycle для `.ipk` и `.apk`

## Установка

```bash
wget -O /root/install.sh https://raw.githubusercontent.com/ang3el7z/luci-app-simo/main/install.sh && chmod 0755 /root/install.sh && sh /root/install.sh
```

Действия установщика:

- `sh /root/install.sh install`
- `sh /root/install.sh update`
- `sh /root/install.sh reinstall`
- `sh /root/install.sh remove`

## Сборка

```bash
docker build -f Dockerfile-ipk -t simo-ipk .
docker build -f Dockerfile-apk -t simo-apk .
```

## Лицензия

MIT. См. [LICENSE](./LICENSE).