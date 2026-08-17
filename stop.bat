@echo off
title Kaitori Marketing - Stop
echo Stopping Kaitori Marketing server (port 5300)...

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5300" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p >nul 2>&1
  set FOUND=1
)

if "%FOUND%"=="1" (
  echo Stopped.
) else (
  echo No running server found.
)

echo.
echo This window closes in 2 seconds...
ping -n 3 127.0.0.1 >nul
