#!/bin/bash
# Вход в Grok для portugrok по коду устройства: команда ждёт подтверждения в браузере,
# поэтому запускаем её в фоне и показываем ссылку и код из лога.
su - portugrok -c 'rm -f $HOME/login.log; nohup $HOME/.grok/bin/grok login --device-auth > $HOME/login.log 2>&1 &'
sleep 8
cat /home/portugrok/login.log
