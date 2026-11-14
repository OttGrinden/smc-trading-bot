@echo off
cd /d "%~dp0.."
node scripts\paper_runbook.mjs --run-scan >> trading\logs\scheduler.log 2>&1
