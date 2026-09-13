@echo off
chcp 65001 >nul
title Telegram Bot (watchdog)
echo -------------- Telegram BOT START (watchdog) --------------
echo 看门狗模式：崩溃后 30 秒自动重启，并通知管理员
echo 直接启动（无看门狗）：node index.js webui
echo.
node watchdog.js webui
echo.
echo 看门狗已退出。
pause
