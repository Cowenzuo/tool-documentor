@echo off
setlocal
cd /d "%~dp0"
title Documentor - 一键启动

echo [1/1] 启动 Documentor（默认发布版，见 scripts\start-documentor.cjs）...
echo.
set DOC_START_HOLD=1
node "scripts\start-documentor.cjs" %*
set EXITCODE=%errorlevel%
endlocal & exit /b %EXITCODE%