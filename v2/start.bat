@echo off
title Precision Explorer v2
cd /d "%~dp0"

echo ============================================
echo  Precision Explorer v2 - Serveur local
echo ============================================
echo.
echo URL : http://localhost:8080/gpx_enduro_generator.html
echo.
echo Fermez cette fenetre pour arreter le serveur.
echo.

start "" "http://localhost:8080/gpx_enduro_generator.html"
python -m http.server 8080
