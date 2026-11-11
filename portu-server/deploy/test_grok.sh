#!/bin/bash
# Проверка Grok на сервере: рисует ли image_gen. Пишет файл в рабочую папку portugrok.
su - portugrok -c 'mkdir -p $HOME/portu-work/test && cd $HOME/portu-work/test && rm -f apple.png && timeout 300 $HOME/.grok/bin/grok -p "Generate one image with the image_gen tool, aspect_ratio 1:1: a single red apple on a plain white surface, photorealistic. Save it to apple.png in the current folder. Print DONE when the file exists." --yolo --max-turns 10 --disallowed-tools web_search,web_fetch 2>&1 | tail -3; ls -la $HOME/portu-work/test'
