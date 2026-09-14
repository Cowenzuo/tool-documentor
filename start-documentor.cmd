@echo off
setlocal
cd /d "%~dp0"
title Documentor - 一键启动

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Node.js，请安装 Node.js 22 或更高版本后重试。
    pause
    exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 pnpm。Node.js 自带 corepack，请先执行: corepack enable
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [提示] 首次运行，正在安装依赖（pnpm install）...
    call pnpm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

echo [1/2] 检查 workspace 库（core/templates/postprocess/docx）...
node scripts\ensure-libs.cjs
if errorlevel 1 (
    echo [错误] 库构建失败，请检查上方报错信息。
    pause
    exit /b 1
)

echo [2/2] 启动 Documentor 桌面应用...
call pnpm --filter @documentor/desktop dev

echo.
echo 应用已退出。
pause
