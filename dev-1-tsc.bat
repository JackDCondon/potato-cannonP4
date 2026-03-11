@echo off
title Potato Cannon - TypeScript Compiler
echo Starting TypeScript compiler in watch mode...
cd /d "%~dp0\apps\daemon"
npx tsc -b -w
