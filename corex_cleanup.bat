@echo off
echo ==============================================
echo   CoreX - Limpieza y reorganizacion del repo
echo ==============================================
echo.

cd /d "%~dp0"

REM -- 1. Crear carpeta tools --
if not exist "tools" (
    mkdir tools
    echo [OK] Carpeta tools creada
) else (
    echo [--] Carpeta tools ya existe
)

REM -- 2. Mover herramientas a tools --
if exist "aog_sniffer.js" (
    move /Y "aog_sniffer.js" "tools\aog_sniffer.js" >nul
    echo [OK] aog_sniffer.js movido a tools
) else (
    echo [--] aog_sniffer.js no encontrado
)

if exist "test_pgn253.js" (
    move /Y "test_pgn253.js" "tools\test_pgn253.js" >nul
    echo [OK] test_pgn253.js movido a tools
) else (
    echo [--] test_pgn253.js no encontrado
)

if exist "nmea.js" (
    move /Y "nmea.js" "tools\nmea.js" >nul
    echo [OK] nmea.js movido a tools
) else (
    echo [--] nmea.js no encontrado
)

REM -- 3. Borrar archivos obsoletos --
echo.
echo Borrando archivos obsoletos...

if exist "debug_aoglog.js" (
    del /F "debug_aoglog.js"
    echo [OK] debug_aoglog.js eliminado
) else (
    echo [--] debug_aoglog.js no encontrado
)

if exist "sniff_aog.js" (
    del /F "sniff_aog.js"
    echo [OK] sniff_aog.js eliminado
) else (
    echo [--] sniff_aog.js no encontrado
)

echo.
echo ==============================================
echo   Listo! Revisar estructura con: dir /s /b
echo ==============================================
echo.
pause
