@echo off
setlocal
rem ===================================================================
rem  Model link proxy - standalone launcher
rem
rem  For clients that can only set a base url and cannot inject custom
rem  request headers (WorkBuddy, Cline, Roo Code, Continue, any
rem  OpenAI-compatible SDK). OpenCode Go requires x-opencode-session;
rem  this proxy adds it.
rem
rem  Shipped with dsh-sec-config: ..\lib\model-proxy.js
rem  Plain Node standard library, no dependencies.
rem
rem    model-proxy.cmd           run in foreground (Ctrl+C to stop)
rem    model-proxy.cmd bg        run in background
rem    model-proxy.cmd stop      stop the background instance
rem    model-proxy.cmd help      show script options
rem
rem  Port / upstream via environment variables:
rem    set MODEL_PROXY_PORT=8788
rem    set MODEL_PROXY_UPSTREAM=https://opencode.ai/zen/go
rem ===================================================================

set "SCRIPT=%~dp0..\lib\model-proxy.js"
if "%MODEL_PROXY_PORT%"=="" set "MODEL_PROXY_PORT=8788"
if "%MODEL_PROXY_UPSTREAM%"=="" set "MODEL_PROXY_UPSTREAM=https://opencode.ai/zen/go"

set "NODE_BIN="
where node >nul 2>nul && set "NODE_BIN=node"
if not defined NODE_BIN if exist "%USERPROFILE%\.workbuddy\binaries\node\current\node.exe" set "NODE_BIN=%USERPROFILE%\.workbuddy\binaries\node\current\node.exe"
if not defined NODE_BIN (
  echo [x] node not found. Add node to PATH and retry.
  exit /b 1
)

if /i "%~1"=="stop" (
  echo [*] stopping whatever listens on port %MODEL_PROXY_PORT% ...
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%MODEL_PROXY_PORT% " ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>nul
  echo [*] done.
  exit /b 0
)

if /i "%~1"=="help" (
  "%NODE_BIN%" "%SCRIPT%" --help
  exit /b 0
)

if /i "%~1"=="bg" (
  echo [*] starting in background: port %MODEL_PROXY_PORT% -^> %MODEL_PROXY_UPSTREAM%
  start "model-proxy" /min "%NODE_BIN%" "%SCRIPT%" --port %MODEL_PROXY_PORT% --upstream "%MODEL_PROXY_UPSTREAM%"
  echo [*] client base URL: http://127.0.0.1:%MODEL_PROXY_PORT%/v1
  echo [*] health check:   curl http://127.0.0.1:%MODEL_PROXY_PORT%/__health
  exit /b 0
)

echo [*] running in foreground: port %MODEL_PROXY_PORT% -^> %MODEL_PROXY_UPSTREAM%   (Ctrl+C to stop)
"%NODE_BIN%" "%SCRIPT%" --port %MODEL_PROXY_PORT% --upstream "%MODEL_PROXY_UPSTREAM%"
