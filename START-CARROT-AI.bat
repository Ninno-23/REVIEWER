@echo off
setlocal
cd /d "%~dp0"
if "%OPENAI_API_KEY%"=="" if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /I "%%A"=="OPENAI_API_KEY" set "OPENAI_API_KEY=%%B"
)
echo.
echo ================================================
echo   StudyVault - Carrot AI v154.0
 echo ================================================
echo.
if "%OPENAI_API_KEY%"=="" (
  echo OpenAI API key is not configured.
  echo Carrot will still start with local/offline features.
  echo To enable flagship cloud chat and AI image generation,
  echo set OPENAI_API_KEY in your environment or .env file.
  echo.
) else (
  echo OpenAI API key detected. Cloud AI features are enabled.
  echo.
)
start "Carrot AI Server" cmd /k "cd /d "%~dp0" && python server.py"
timeout /t 2 /nobreak >nul
start "Carrot Web" cmd /k "cd /d "%~dp0" && python -m http.server 5500"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:5500/index.html"
echo Carrot is running.
