#!/bin/bash
# Установка Grok CLI официальным установщиком xAI для пользователя portugrok (без sudo).
# anton разрешил 11.11.2026. Запуск: ssh serv_raboch bash /opt/portu/deploy/install_grok.sh
set -e
su - portugrok -c 'curl -fsSL https://x.ai/cli/install.sh | bash' 2>&1 | tail -5
su - portugrok -c '$HOME/.grok/bin/grok --version'
