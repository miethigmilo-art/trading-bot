@echo off
:: Wöchentlicher Trading Report Download
:: Als Windows Task Scheduler Aufgabe einrichten: Montags 08:00 Uhr

set BOT_URL=https://trading-bot-production-86d8.up.railway.app
set REPORT_DIR=C:\TradingBot\Reports

if not exist "%REPORT_DIR%" mkdir "%REPORT_DIR%"

for /f "tokens=1-3 delims=." %%a in ('date /t') do (
  set TAG=%%a
  set MON=%%b
  set JAHR=%%c
)
set DATUM=%JAHR%-%MON%-%TAG%

echo Lade Wochenberichte...

for %%s in (mittel aggressiv goldglobe test konservativ optimiert sideways test2 steady) do (
  echo Strategie: %%s
  curl -s "%BOT_URL%/api/report/weekly/%%s" -o "%REPORT_DIR%\trading_report_%%s_%DATUM%.html"
  if errorlevel 1 (
    echo FEHLER bei %%s
  ) else (
    echo OK: %REPORT_DIR%\trading_report_%%s_%DATUM%.html
  )
)

echo.
echo Alle Berichte gespeichert in %REPORT_DIR%
pause
