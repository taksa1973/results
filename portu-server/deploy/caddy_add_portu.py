#!/usr/bin/env python3
"""Добавляет в /etc/caddy/Caddyfile блок /portu в секцию syferpu.top (до tinyauth). Повторный запуск ничего не меняет."""
import sys

P = "/etc/caddy/Caddyfile"
s = open(P, encoding="utf-8").read()
if "handle /portu*" in s:
    print("блок /portu уже есть")
    sys.exit(0)
head = "syferpu.top {\n"
if head not in s:
    sys.exit("нет секции syferpu.top")
block = """\t# --- Португальский: карточки и звонки. Без tinyauth: у приложения свой вход по паролю ---
\t# Путь-матчер Caddy ставит раньше именованных и catch-all, но держим блок первым для ясности.
\thandle /portu* {
\t\theader X-Robots-Tag "noindex, nofollow, noarchive, nosnippet"
\t\trequest_body {
\t\t\tmax_size 20MB
\t\t}
\t\treverse_proxy 127.0.0.1:8095
\t}

"""
s = s.replace(head, head + block, 1)
open(P, "w", encoding="utf-8").write(s)
print("блок /portu добавлен")
