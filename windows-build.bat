@echo off
title Glazed Browser
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Glazed.ps1"
if errorlevel 1 pause
