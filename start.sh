#!/bin/bash

# Matar todas as instâncias do bot
pkill -f "node index.js"
sleep 1

# Iniciar o bot
node index.js
